import { ethers } from 'ethers';

interface VolumeBotConfig {
  provider: ethers.Provider;
  factoryAddress: string;
  windowMs?: number; // Sliding window, default 5 minutes
  minVolumeBNB?: number; // Threshold volume in BNB
  onAlert?: (pair: string, volumeBNB: number) => void;
}

/**
 * Simple on-chain liquidity volume monitor.
 * Listens for Transfer events on new pairs and aggregates trade volume
 * in BNB equivalent over a sliding window.
 */
export class VolumeBot {
  private provider: ethers.Provider;
  private factoryAddress: string;
  private windowMs: number;
  private minVolumeBNB: number;
  private onAlert?: (pair: string, volumeBNB: number) => void;

  private pairVolumes: Map<string, { lastUpdated: number; volume: number }> = new Map();
  private factoryAbi = [
    'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  ];
  private pairAbi = [
    'event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)',
  ];

  constructor(config: VolumeBotConfig) {
    this.provider = config.provider;
    this.factoryAddress = config.factoryAddress;
    this.windowMs = config.windowMs || 5 * 60 * 1000;
    this.minVolumeBNB = config.minVolumeBNB || 5;
    this.onAlert = config.onAlert;
  }

  public start() {
    console.log('🟢 VolumeBot started.');
    const factory = new ethers.Contract(this.factoryAddress, this.factoryAbi, this.provider);

    factory.on('PairCreated', (token0: string, token1: string, pair: string) => {
      console.log(`[VolumeBot] New pair detected: ${pair} (${token0}, ${token1})`);
      this.watchPair(pair);
    });

    setInterval(() => this.cleanup(), this.windowMs);
  }

  private watchPair(pairAddress: string) {
    const pair = new ethers.Contract(pairAddress, this.pairAbi, this.provider);
    pair.on('Swap', async (sender, amount0In, amount1In, amount0Out, amount1Out) => {
      const volBNB = parseFloat(ethers.formatEther(amount0In > 0 ? amount0In : amount1In));
      this.addVolume(pairAddress, volBNB);
    });
  }

  private addVolume(pair: string, amount: number) {
    const now = Date.now();
    const existing = this.pairVolumes.get(pair) || { lastUpdated: now, volume: 0 };
    existing.volume += amount;
    existing.lastUpdated = now;
    this.pairVolumes.set(pair, existing);

    if (existing.volume >= this.minVolumeBNB) {
      console.log(`🚀 High volume detected: ${pair} — ${existing.volume.toFixed(3)} BNB`);
      if (this.onAlert) this.onAlert(pair, existing.volume);
      existing.volume = 0; // reset after alert
    }
  }

  private cleanup() {
    const now = Date.now();
    for (const [pair, info] of this.pairVolumes) {
      if (now - info.lastUpdated > this.windowMs) {
        this.pairVolumes.delete(pair);
      }
    }
  }
}
