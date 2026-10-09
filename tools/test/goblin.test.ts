import { RuleTester } from 'oxlint/plugins-dev'
import { describe, it } from 'vitest'
import { noProcessEnv, noSilentCatch, requireDisableDescription, resourceNameViaStage } from '../oxlint/goblin.ts'

RuleTester.describe = describe
RuleTester.it = it
const tester = new RuleTester({ languageOptions: { parserOptions: { lang: 'ts' } } })

tester.run('no-process-env', noProcessEnv, {
  valid: [
    // apps/runtime/src/resources.ts
    "export const stage = typeof process === 'undefined' ? undefined : stageFromEnv('runtime', process.env ?? {})",
    "const stage = stageFromEnv('runtime', process.env)",
    "const stage = Stage.stageFromEnv('runtime', process.env as Record<string, string>)",
    'const process = { env: {} }; const x = process.env',
    "const name = Config.String('MYINBOX_OWNER_EMAIL')",
  ],
  invalid: [
    { code: 'const port = process.env.PORT', errors: [{ messageId: 'env' }] },
    { code: "const token = process.env['TOKEN']", errors: [{ messageId: 'env' }] },
    { code: 'const { A, B } = process.env', errors: [{ messageId: 'env' }] },
    {
      code: "const stage = (globalThis as { process?: { env?: Record<string, string> } }).process?.env?.['MYAPPS_STAGE']",
      errors: [{ messageId: 'env' }],
    },
    { code: "const s = stageFromEnv(process.env, 'x')", errors: [{ messageId: 'env' }] },
    { code: "const s = other('runtime', process.env)", errors: [{ messageId: 'env' }] },
  ],
})

tester.run('resource-name-via-stage', resourceNameViaStage, {
  valid: [
    // apps/runtime/alchemy.run.ts
    "const db = Cloudflare.D1.Database('MyagentDb', { ...D1_DEFAULTS, name: stage.resourceName('db'), migrations })",
    "const media = Cloudflare.R2.Bucket('MyagentMedia', { name: stage.resourceName('media') })",
    "const web = Cloudflare.Website.Vite('Web', { name: stage.workerName, workersDev: stage.workersDev })",
    // apps/runtime/src/resources.ts
    "export const Registry = Cloudflare.D1.Database('Registry', { ...D1_DEFAULTS, migrations: dir, ...(stage === undefined ? {} : { name: stage.resourceName('registry') }) })",
    "export const MailStore = Cloudflare.R2.Bucket('MailStore', stage === undefined ? {} : { name: stage.resourceName('mail') })",
    // apps/runtime/src/worker.ts (curried class factory)
    "export default class Mail extends Cloudflare.Worker<Mail>()('Mail', { main: import.meta.url, ...(stage === undefined ? {} : { name: stage.workerName, observability: stage.observability }) }) {}",
    // optional chain on the stage
    "const db = Cloudflare.D1.Database('Db', { name: stage?.resourceName('db') })",
    // bindings and account-level resources are not named resources
    "const binding = Cloudflare.DurableObject('ChatDO')",
    "const mail = Cloudflare.Email.SendEmail('OtpMail', { allowedSenderAddresses: [sender] })",
    "Cloudflare.Email.CatchAll('MyInboxCatchAll', { name: 'My Inbox owned addresses' })",
    "Cloudflare.Alerting.NotificationPolicy('Policy', { name: `goblin-${stage.name}-x` })",
    // props built elsewhere cannot be checked here
    "const db = Cloudflare.D1.Database('Db', props)",
  ],
  invalid: [
    { code: "const db = Cloudflare.D1.Database('Db', { migrations })", errors: [{ messageId: 'missing' }] },
    { code: "const db = Cloudflare.D1.Database('Db')", errors: [{ messageId: 'missing' }] },
    { code: "const b = Cloudflare.R2.Bucket('B', { name: 'runtime-dev-media' })", errors: [{ messageId: 'literal' }] },
    { code: "const w = Cloudflare.Website.Vite('Web', { name: `runtime-${s}` })", errors: [{ messageId: 'literal' }] },
    {
      code: "class W extends Cloudflare.Worker<W>()('W', { main: import.meta.url, name: 'mail-dev' }) {}",
      errors: [{ messageId: 'literal' }],
    },
    {
      code: "const b = Cloudflare.R2.Bucket('B', cond ? {} : { name: stage.resourceName(role) })",
      errors: [{ messageId: 'literal' }],
    },
    {
      code: "const q = Cloudflare.Queue('Q', { name: 'q' })",
      options: [{ named: ['Queue'] }],
      errors: [{ messageId: 'literal' }],
    },
  ],
})

tester.run('require-disable-description', requireDisableDescription, {
  valid: [
    "// oxlint-disable-next-line typescript/no-explicit-any -- the Effect requirements are the app's\nconst x = 1",
    '/* eslint-disable no-console -- operator script prints its report */\nconsole.log(1)',
    '// a comment that mentions oxlint-disable in passing\nconst x = 1',
    '// @effect-diagnostics-next-line globalDate:off -- the log line needs wall-clock time\nconst t = Date.now()',
    '// @effect-diagnostics floatingEffect:error\nconst x = 1',
    '// @effect-diagnostics-next-line schemaNumber:message -- a count decoded from our own storage\nconst n = 1',
  ],
  invalid: [
    { code: '// oxlint-disable-next-line no-console\nconsole.log(1)', errors: [{ messageId: 'reason' }] },
    { code: '/* eslint-disable */\nconst x = 1', errors: [{ messageId: 'reason' }] },
    { code: '// oxlint-disable-line no-console -- why\nconsole.log(1)', errors: [{ messageId: 'reason' }] },
    {
      code: '// @effect-diagnostics-next-line globalDate:off\nconst t = Date.now()',
      errors: [{ messageId: 'reason' }],
    },
    { code: '// @effect-diagnostics globalFetch:off\nconst x = 1', errors: [{ messageId: 'reason' }] },
    // A lowered severity is as good as off.
    { code: '// @effect-diagnostics-next-line floatingEffect:warning\nconst x = 1', errors: [{ messageId: 'reason' }] },
    { code: '// @effect-diagnostics leakingRequirements:message\nconst x = 1', errors: [{ messageId: 'reason' }] },
    {
      code: '/* @effect-diagnostics-next-line globalDate:error schemaSync:suggestion */\nconst x = 1',
      errors: [{ messageId: 'reason' }],
    },
  ],
})

tester.run('no-silent-catch', noSilentCatch, {
  valid: [
    // rethrow, report, or carry a failure on
    'try { run() } catch (error) { throw new Wrapped(error) }',
    "try { run() } catch (error) { logEvent('warn', 'job', { kind: 'reconcile' }) }",
    'try { run() } catch (error) { reportJobFailure(error) }',
    "promise.catch((error: unknown) => reportFailure('sync')(error))",
    'promise.catch((error: unknown) => Promise.reject(error))',
    'new Promise((resolve, reject) => source.then(resolve).catch((error: unknown) => reject(error)))',
    'promise.catch(reportError)',
    "load().catch((error: unknown) => setError(messageOf(error, 'load')))",
    'effect.pipe(Effect.catch((error) => Effect.fail(new Internal({ reason: error._tag }))))',
    'effect.pipe(Effect.catchCause(Effect.failCause))',
    'effect.pipe(Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.succeed(1))))',
    'effect.pipe(Effect.catch(() => Effect.gen(function* () { return yield* new NotFound({ what: "x" }) })))',
    "Effect.catch(effect, (error) => Effect.gen(function* () { yield* logEvent('warn', 'rpc'); return 0 }))",
    // typed handling of one failure is not a catch-all
    "effect.pipe(Effect.catchTag('NotFound', () => Effect.succeed(undefined)))",
    // the reason is on the line above, or the handler's first line
    '// expected: a missing config file means defaults\ntry { read() } catch { use(defaults) }',
    'try { read() } catch {\n  // expected: a missing config file means defaults\n  use(defaults)\n}',
    'try { read() } catch { /* expected: a missing config file means defaults */ }',
    '// expected: the beacon is best effort, nothing waits\nvoid fetch(url).catch(() => undefined)',
    'effect.pipe(\n  // expected: a closed socket has nothing left to tell\n  Effect.ignore,\n)',
    'effect.pipe(\n  // expected: no saved draft is an empty draft\n  Effect.orElseSucceed(() => ""),\n)',
  ],
  invalid: [
    { code: 'try { run() } catch {}', errors: [{ messageId: 'silent' }] },
    { code: 'try { run() } catch (error) { return undefined }', errors: [{ messageId: 'silent' }] },
    { code: 'try { run() } catch (error) { console.error(error) }', errors: [{ messageId: 'silent' }] },
    { code: 'promise.catch(() => undefined)', errors: [{ messageId: 'silent' }] },
    { code: 'promise.catch(noop)', errors: [{ messageId: 'silent' }] },
    { code: 'effect.pipe(Effect.catch(() => Effect.succeed(0)))', errors: [{ messageId: 'silent' }] },
    { code: 'Effect.catchCause(effect, () => Effect.void)', errors: [{ messageId: 'silent' }] },
    { code: 'effect.pipe(Effect.catchIf(isRetryable, () => Effect.void))', errors: [{ messageId: 'silent' }] },
    { code: 'effect.pipe(Effect.orElseSucceed(() => []))', errors: [{ messageId: 'silent' }] },
    { code: 'effect.pipe(Effect.ignore)', errors: [{ messageId: 'silent' }] },
    { code: 'Effect.ignoreCause(effect)', errors: [{ messageId: 'silent' }] },
    // a reason must say something, and a comment further up does not count
    { code: '// expected: yes\ntry { read() } catch {}', errors: [{ messageId: 'silent' }] },
    {
      code: '// expected: a missing config file means defaults\nconst x = 1\ntry { read() } catch {}',
      errors: [{ messageId: 'silent' }],
    },
    // a report in the try block does not cover the catch
    { code: "try { reportFailure('x') } catch {}", errors: [{ messageId: 'silent' }] },
  ],
})
