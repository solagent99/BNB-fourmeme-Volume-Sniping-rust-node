import 'dotenv/config';
import { ethers } from 'ethers';
import fetch from 'node-fetch';

const WS_RPC = process.env.WS_RPC!;
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS!;
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS!;
const WBNB_ADDRESS = process.env.WBNB_ADDRESS || '';
const EXECUTOR_URL = process.env.EXECUTOR_URL || 'http://127.0.0.1:8080';

if (!WS_RPC || !PRIVATE_KEY || !FACTORY_ADDRESS || !ROUTER_ADDRESS) {
  console.error('Missing required env vars — see .env.example');
  process.exit(1);
}

const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
];
const PAIR_ABI = [
  'event Mint(address indexed sender, uint amount0, uint amount1)',
  'event Transfer(address indexed from, address indexed to, uint256 value)'
];

const ERC20_MINIMAL_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function owner() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)'
];

const ROUTER_ABI = [
  'function WETH() view returns (address)',
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)'
];

async function isContract(provider: ethers.Provider, address: string) {
  try {
    const code = await provider.getCode(address);
    return code && code !== '0x';
  } catch (e) {
    console.warn('isContract error', e);
    return false;
  }
}

async function readERC20Metadata(provider: ethers.Provider, token: string) {
  const c = new ethers.Contract(token, ERC20_MINIMAL_ABI, provider);
  const meta: { name?: string; symbol?: string; decimals?: number; totalSupply?: string } = {};
  try {
    meta.name = await c.name();
  } catch {}
  try {
    meta.symbol = await c.symbol();
  } catch {}
  try {
    const d = await c.decimals();
    meta.decimals = typeof d === 'number' ? d : Number(d);
  } catch {}
  try {
    const ts = await c.totalSupply();
    meta.totalSupply = ts?.toString();
  } catch {}
  return meta;
}

async function hasOwner(provider: ethers.Provider, token: string) {
  const c = new ethers.Contract(token, ERC20_MINIMAL_ABI, provider);
  try {
    const owner = await c.owner();
    // If owner exists and is not zero address, return owner string; otherwise null
    if (owner && owner !== ethers.ZeroAddress) return owner;
  } catch {
    // owner() not present or reverted
  }
  return null;
}

async function canTransfer(wallet: ethers.Wallet, token: string) {
  // Use callStatic.transfer simulation to detect immediate transfer reverts
  const c = new ethers.Contract(token, ERC20_MINIMAL_ABI, wallet);
  try {
    const decimalsRaw = await c.decimals();
    const decimals = typeof decimalsRaw === 'number' ? decimalsRaw : Number(decimalsRaw);
    const amount = ethers.parseUnits('1', decimals || 18); // try to transfer 1 token unit
    // callStatic.transfer will simulate and revert if transfer is blocked
    if (!c.callStatic || typeof c.callStatic.transfer !== 'function') {
      // fallback — cannot simulate; assume potentially risky
      return { ok: false, reason: 'callStatic.transfer not available' };
    }
    await c.callStatic.transfer(wallet.address, amount);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: (err && err.message) ? err.message : 'transfer simulation failed' };
  }
}

async function getAmountsOutCheck(provider: ethers.Provider, routerAddress: string, buyAmountBnB: string, wbnb: string, token: string) {
  const router = new ethers.Contract(routerAddress, ROUTER_ABI, provider);
  try {
    const amountIn = ethers.parseEther(buyAmountBnB);
    const amounts = await router.getAmountsOut(amountIn, [wbnb, token]);
    if (!amounts || amounts.length < 2) return { ok: false, reason: 'getAmountsOut returned empty' };
    const expected = amounts[1];
    if (expected && expected.gt(0)) return { ok: true, expected: expected.toString() };
    return { ok: false, reason: 'expected amount is zero' };
  } catch (err: any) {
    return { ok: false, reason: (err && err.message) ? err.message : 'getAmountsOut error' };
  }
}

async function preBuyChecks(provider: ethers.Provider, wallet: ethers.Wallet, routerAddress: string, token: string, buyAmountBnB: string) {
  const reasons: string[] = [];

  // 1) Must be a contract
  const isC = await isContract(provider, token);
  if (!isC) reasons.push('token is not a contract');

  // 2) Read ERC20 metadata
  const meta = await readERC20Metadata(provider, token);

  if (!meta.symbol || !meta.decimals) {
    reasons.push('token missing symbol/decimals (not standard ERC20?)');
  }

  // 3) Owner presence (optional heuristic)
  const owner = await hasOwner(provider, token);
  if (owner) {
    reasons.push(`token has owner: ${owner} (owner-controlled token)`);
  }

  // 4) Attempt a transfer simulation (callStatic.transfer) to see if token allows transfers
  const transferCheck = await canTransfer(wallet, token);
  if (!transferCheck.ok) {
    reasons.push(`transfer simulation failed: ${transferCheck.reason}`);
  }

  // 5) getAmountsOut check via router (confirm path exists)
  const amountsCheck = await getAmountsOutCheck(provider, routerAddress, buyAmountBnB, WBNB_ADDRESS || routerAddress, token);
  if (!amountsCheck.ok) {
    reasons.push(`getAmountsOut failed: ${amountsCheck.reason}`);
  }

  return { ok: reasons.length === 0, reasons, meta, amountsCheck };
}

async function main() {
  console.log('Connecting to', WS_RPC);
  const provider = new ethers.WebSocketProvider(WS_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
  const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

  // Try to read WBNB from router (fallback to env override)
  let wbnbAddress = WBNB_ADDRESS;
  if (!wbnbAddress) {
    try {
      wbnbAddress = await router.WETH();
      console.log('Router WBNB/WETH:', wbnbAddress);
    } catch (e) {
      console.warn('Could not read WETH from router; set WBNB_ADDRESS in .env to override.');
    }
  }

  console.log('Listening for PairCreated events...');

  factory.on('PairCreated', async (token0: string, token1: string, pair: string) => {
    console.log('PairCreated', token0, token1, pair);

    // Optional filter: only care about WBNB pairs
    const wbnb = wbnbAddress ? wbnbAddress.toLowerCase() : null;
    if (wbnb && token0.toLowerCase() !== wbnb && token1.toLowerCase() !== wbnb) {
      console.log('Not a WBNB pair — skipping');
      return;
    }

    const targetToken = (wbnb && token0.toLowerCase() === wbnb) ? token1 : token0;
    console.log('Target token candidate:', targetToken);

    const pairContract = new ethers.Contract(pair, PAIR_ABI, provider);

    const onLiquidity = async (...args: any[]) => {
      console.log('Liquidity detected for', targetToken);

      try {
        // Run pre-buy checks
        const buyAmt = process.env.BUY_AMOUNT_BNB || '0.02';
        console.log('Running pre-buy checks for', targetToken, 'buyAmtBNB=', buyAmt);

        const checks = await preBuyChecks(provider, wallet, ROUTER_ADDRESS, targetToken, buyAmt);

        if (!checks.ok) {
          console.warn('Pre-buy checks failed. Reasons:', checks.reasons);
          // Do not call executor — abort. You may still alert / log more details here.
          pairContract.removeAllListeners();
          return;
        }

        console.log('Pre-buy checks passed. Token meta:', checks.meta, 'amountsCheck:', checks.amountsCheck);

        // Compose payload for Rust executor
        const payload = {
          target_token: targetToken,
          buy_amount_bnb: buyAmt,
          slippage: parseFloat(process.env.SLIPPAGE || '0.30'),
          deadline_secs: parseInt(process.env.DEADLINE_SECS || '60')
        };

        const res = await fetch(`${EXECUTOR_URL}/buy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        const data = await res.json().catch(() => ({ error: 'invalid json response from executor' }));
        console.log('Executor response:', data);
      } catch (err) {
        console.error('Error in onLiquidity handler:', err);
      } finally {
        pairContract.removeAllListeners();
      }
    };

    pairContract.on('Mint', onLiquidity);
    pairContract.on('Transfer', onLiquidity);

    // safety timeout
    setTimeout(() => {
      pairContract.removeAllListeners();
      console.log('Timeout — stopped listening to this pair');
    }, 2 * 60 * 1000);
  });

  provider._websocket.on('close', (code: number) => {
    console.error('WS closed', code);
    process.exit(1);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
