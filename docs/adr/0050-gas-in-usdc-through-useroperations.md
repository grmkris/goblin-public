# 0050: Gas in USDC through UserOperations; the relay removed

Accepted 2026-10-12 with the owner, the night before the Colosseum deadline. The plan is
(Goblin Wallet): its on-chain allowance layer and its rejection of Privy's gas sponsorship.

## Context

Until now an owner's EIP-7702 upgrade was a type-4 transaction our relay sent and paid for in ETH. The relay was a hot
EOA whose key was a Worker secret, behind a `WalletRelay` Durable Object with a daily quota. The agent sent ordinary
transactions and paid its own gas in ETH, which nothing gave it: every agent was funded by hand.

**Privy's embedded wallet can send a type-4 transaction.** Its React SDK (`@privy-io/react-auth` 3.45.0, still in
3.48.1) builds the request field by field and leaves `authorization_list` out. Privy's server then answers 500. With
one field added, an owner's self-sent upgrade landed on Base (`0x13e75ea3…1f1c`). That fix is reported upstream; goblin
does not carry it, since owners no longer send their own transactions.

The owner chose the long-term pattern over the quick one: **no account of the wallet ever needs ETH.**

## Decision

**Every EVM send is an ERC-4337 v0.7 UserOperation, its gas paid in USDC.**
- **The account.** Owner and agent addresses are 7702-delegated to MetaMask's `EIP7702StatelessDeleGator`, which is an
  ERC-4337 account on EntryPoint v0.7. Each address stays the same; it gains code. The DeleGator validates its own
  EIP-712 `PackedUserOperation` digest, not the EntryPoint's hash.
- **The sending.** Pimlico bundles every operation, and its ERC-20 paymaster takes the gas in the chain's USDC. The
  batch approves the paymaster for exactly the fee bound: the required prefund plus post-op gas at the maximum fee,
  plus 20%. That bound is refused above a per-chain ceiling ($0.10 on Base and Arbitrum, $3 on Ethereum).
- **The key.** The Worker holds a Pimlico API key (`PIMLICO_API_KEY`), which spends nothing. No Worker key spends ETH.

**The agent acts only through UserOperations** (`@goblin/wallet/balances` `sendCalls`).
- When the agent lacks what a batch spends plus its gas, the batch first redeems exactly that from the owner's
  allowance. A top-up, an approval and a payment then land together or not at all.
- Its first operation carries its own 7702 authorization (`eip7702Auth`).
- A payment keeps its UserOperation hash. An unknown outcome is read back from the bundler
  (`eth_getUserOperationReceipt`): the bundle's own transaction succeeds even when the operation inside it reverted.
- A signer that refuses has sent nothing. A bundler that never answers the send leaves the outcome unknown.
- The Privy policy allows the agent's calls only in their `eth_signUserOperation` form, plus a paymaster approval up to
  the chain's gas ceiling. Privy checks every call of the batch.

**The owner's upgrade is their own UserOperation**, prepared and confirmed like the allowance.
1. The owner signs the 7702 authorization at their current nonce.
2. The Worker prepares an operation that carries it and approves the paymaster. It is stored for five minutes and
   refused when the owner holds less USDC than the fee bound.
3. The browser checks the operation (sender, chain, EntryPoint, one approval to the chain's paymaster within the
   ceiling).
4. The owner signs its typed data.
5. The Worker sends it and reads the delegation back.

So the upgrade needs USDC on that chain, and onboarding asks for USDC.

**The relay is deleted:** the Durable Object (Alchemy deletes its class), its key, its module and its wiring. Its ETH
was swept to the run treasury first.

## Proven on Base mainnet (12 October)

| Path | Gas in USDC | ETH used |
|---|---|---|
| An owner's upgrade, signed in the browser through Privy | 0.0038 | none |
| An agent transfer that redeemed its shortfall plus gas from the allowance in the same batch (`0x5725377f…5d55`) | 0.0073 | none |
| A new agent's first operation, carrying its 7702 authorization and the redeem, then an x402 search (`0xe1662494…2058`) | 0.0098 | none |

## Consequences

- An owner who holds only ETH cannot upgrade until some of it is USDC. Add funds converts it, and onboarding asks for
  USDC.
- Gas no longer depends on a key we fund per chain, so Arbitrum and Ethereum work wherever Pimlico's paymaster is
  deployed (both are).
- Testnets take no UserOperations: the chain table has no Pimlico entry for them, so every EVM send refuses there.
- The ledger's dollar windows still count principal only, so gas is bounded per operation by the ceiling rather than
  reserved.
- A UserOperation hash is recorded when the send returns, not before the receipt wait. A crash in between can still
  lose it.

## Rejected

- **A patched Privy SDK and self-sent upgrades.** They work, but the owner needs ETH on every chain, and the agent would
  still need its own gas.
- **Privy smart wallets.** Their ERC-4337 accounts live at a second address controlled by the embedded wallet. Our
  allowance is MetaMask's delegation framework, which needs the owner account itself to be a DeleGator.
- **Privy's own gas sponsorship.** It delegates the account to Privy's implementation, which would replace the
  DeleGator: an address holds one delegation per chain.
- **Funding the agent's gas in ETH from the owner.** That is the same bound, paid in a token nobody wants to hold.
