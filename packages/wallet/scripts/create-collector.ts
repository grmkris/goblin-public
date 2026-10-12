/**
 * Creates goblin's collector for one stage (ADR 0054): a Privy server wallet owned by the project's policy-admin key
 * quorum, with this service's routine signer as its only additional signer, held to the collector policy
 * (`collectorPolicy` in src/policy). Subscriptions pay into it; it pays its own gas in USDC. Run by hand, with Kris:
 *
 *   bun packages/wallet/scripts/create-collector.ts --env <file> --policy-out <file>
 *       writes the collector policy document (owner: PRIVY_POLICY_ADMIN_ID) to a file; it applies nothing
 *   bun packages/wallet/scripts/create-collector.ts --env <file> --stage dev --policy-id <id> --out <file>
 *       creates the collector once (Privy's idempotency key is per stage), checks who owns and signs for it, and writes
 *       WALLET_COLLECTOR_WALLET_ID and WALLET_COLLECTOR_ADDRESS to <file>, mode 600, refusing an existing file
 *
 * The policy is created in Privy's dashboard (or by its API) from the written document before the second step, which
 * binds it. The collector needs no upgrade step: its first collection carries its EIP-7702 authorization, as an agent's
 * first operation does. It needs a small USDC float on Base for gas before its first collection.
 *
 * The env file is read directly, never through the process environment. Only ids, the address and Privy's machine
 * codes are printed; never a key or a secret.
 */
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs'
import { BASE } from '../src/chains/index.ts'
import { collectorPolicy } from '../src/policy/index.ts'
import { PrivyClient, PrivyError, getWallet, privyId } from '../src/privy/index.ts'

type Env = Readonly<Record<string, string>>

const readEnv = (file: string): Env =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=(.*)$/u.exec(line.trim()))
      .filter((match) => match !== null)
      .map((match) => [match[1] ?? '', match[2] ?? '']),
  )

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const required = (value: string | undefined, name: string): string => {
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

/** Writes `text` to a new file only its owner can read; an existing file is refused, never overwritten. */
const writePrivate = (file: string, text: string): void => {
  const fd = openSync(file, 'wx', 0o600)
  try {
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

const env = readEnv(required(option('--env'), '--env <file>'))
const adminId = required(env['PRIVY_POLICY_ADMIN_ID'], 'PRIVY_POLICY_ADMIN_ID in the env file')

/** The collector policy document for Base, owned by the policy-admin key quorum. */
const writePolicy = (file: string) => {
  writePrivate(file, `${JSON.stringify(collectorPolicy({ ownerId: adminId, chains: [BASE] }), null, 2)}\n`)
  return { policy: file, status: 'written, not applied' }
}

/** The collector, created once per stage and checked: owned by the admins, signed for by us under the policy only. */
const createCollector = async (stage: string, policyId: string, out: string) => {
  if (stage !== 'dev' && stage !== 'prod') throw new Error('--stage must be dev or prod')
  const signerId = required(env['PRIVY_SIGNER_ID'], 'PRIVY_SIGNER_ID in the env file')
  const privy = new PrivyClient({
    appId: required(env['PRIVY_APP_ID'], 'PRIVY_APP_ID in the env file'),
    appSecret: required(env['PRIVY_APP_SECRET'], 'PRIVY_APP_SECRET in the env file'),
  })
  const created = await privy.request(
    'POST',
    '/wallets',
    {
      chain_type: 'ethereum',
      owner_id: privyId(adminId),
      additional_signers: [{ signer_id: privyId(signerId), override_policy_ids: [privyId(policyId)] }],
    },
    { idempotencyKey: `goblin-collector-${stage}` },
  )
  const wallet = await getWallet(privy, String(created['id']))
  const signer = wallet.signers[0]
  if (
    wallet.ownerId !== adminId ||
    wallet.signers.length !== 1 ||
    signer?.signerId !== signerId ||
    signer.policyIds.length !== 1 ||
    signer.policyIds[0] !== policyId
  )
    throw new Error('the collector is not owned and signed for as expected; inspect it in Privy before using it')
  writePrivate(out, `WALLET_COLLECTOR_WALLET_ID=${wallet.id}\nWALLET_COLLECTOR_ADDRESS=${wallet.address}\n`)
  return { stage, walletId: wallet.id, address: wallet.address, policyId, written: out }
}

try {
  const policyOut = option('--policy-out')
  const result =
    policyOut === undefined
      ? await createCollector(
          required(option('--stage'), '--stage dev|prod'),
          required(option('--policy-id'), '--policy-id <id>'),
          required(option('--out'), '--out <file>'),
        )
      : writePolicy(policyOut)
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  // expected: the failure is printed as Privy's status and code only (never a body or a key), and the exit code set.
  console.error(
    error instanceof PrivyError ? error.message : error instanceof Error ? error.message : 'create-collector failed',
  )
  process.exitCode = 1
}
