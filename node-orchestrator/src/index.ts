import 'dotenv/config';
'event Transfer(address indexed from, address indexed to, uint256 value)'
];


async function main() {
console.log('Connecting to', WS_RPC);
const provider = new ethers.WebSocketProvider(WS_RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);


const factory = new ethers.Contract(FACTORY_ADDRESS, FACTORY_ABI, provider);
console.log('Listening for PairCreated events...');


factory.on('PairCreated', async (token0: string, token1: string, pair: string) => {
console.log('PairCreated', token0, token1, pair);


const wbnb = WBNB_ADDRESS ? WBNB_ADDRESS.toLowerCase() : null;
if (wbnb && token0.toLowerCase() !== wbnb && token1.toLowerCase() !== wbnb) {
console.log('Not a WBNB pair — skipping');
return;
}


const targetToken = (wbnb && token0.toLowerCase() === wbnb) ? token1 : token0;
const pairContract = new ethers.Contract(pair, PAIR_ABI, provider);


const onLiquidity = async (...args: any[]) => {
console.log('Liquidity detected for', targetToken);
try {
// Simple pre-buy checks (placeholder — expand before mainnet)
// POST to executor
const payload = {
target_token: targetToken,
buy_amount_bnb: process.env.BUY_AMOUNT_BNB || '0.02',
slippage: parseFloat(process.env.SLIPPAGE || '0.30'),
deadline_secs: parseInt(process.env.DEADLINE_SECS || '60')
};


const res = await fetch(`${EXECUTOR_URL}/buy`, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(payload)
});
const data = await res.json();
console.log('Executor response:', data);
} catch (err) {
console.error('Error calling executor:', err);
} finally {
pairContract.removeAllListeners();
}
};


pairContract.on('Mint', onLiquidity);
pairContract.on('Transfer', onLiquidity);


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