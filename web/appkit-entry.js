import { createAppKit } from '@reown/appkit';
import { defineChain } from '@reown/appkit/networks';
import { EthersAdapter } from '@reown/appkit-adapter-ethers';

const PROJECT_ID = '695ebda6ed80941214ed0cb7499b92fd';

export function initializeAppKit(network) {
  const chainId = Number(network.chainId);
  const explorerUrl = network.explorerUrl || `${location.origin}/`;
  const chain = defineChain({
    id: chainId,
    caipNetworkId: `eip155:${chainId}`,
    chainNamespace: 'eip155',
    name: 'Lidex',
    nativeCurrency: {
      name: 'Lidex Coin',
      symbol: network.currency?.symbol || 'LDX',
      decimals: network.currency?.decimals ?? 18,
    },
    rpcUrls: {
      default: { http: [network.rpcUrl] },
    },
    blockExplorers: {
      default: { name: 'Lidex Explorer', url: explorerUrl },
    },
  });
  const modal = createAppKit({
    adapters: [new EthersAdapter()],
    networks: [chain],
    defaultNetwork: chain,
    projectId: PROJECT_ID,
    metadata: {
      name: 'Lidex',
      description: 'Lidex explorer and asset studio',
      url: location.origin,
      icons: [`${location.origin}/lidex-logo.png`],
    },
    features: {
      analytics: false,
      email: false,
      socials: false,
      onramp: false,
      swaps: false,
    },
    themeMode: 'dark',
  });

  return {
    open: (view) => modal.open({ view, namespace: 'eip155' }),
    getAccount: () => modal.getAccount('eip155'),
    getChainId: () => modal.getChainId(),
    getWalletProvider: () => modal.getWalletProvider(),
    subscribeAccount: (callback) => modal.subscribeAccount(callback, 'eip155'),
  };
}
