import * as Cause from 'effect/Cause'
import * as Exit from 'effect/Exit'
import * as Option from 'effect/Option'
import { FILE_LIMITS } from '@goblin/contracts'
import { InvalidInput, PayloadTooLarge, type AppError, toAppError } from '../http/errors.ts'
import { errorBody, statusOf } from '../http/respond.ts'
import type { ExitProgram } from '../runtime/bridge.ts'
import { Files } from './service.ts'

/** Images the browser may show in place; anything else downloads, so an uploaded page never runs on the app's origin. */
const INLINE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

const failed = (cause: unknown): Response => {
  const error = toAppError(cause)
  return Response.json(errorBody(error), { status: statusOf(error) })
}

/** The program's value as a response, or its failure as the public error body. */
const answer = <A>(exit: Exit.Exit<A, AppError>, ok: (value: A) => Response): Response =>
  Exit.isSuccess(exit)
    ? ok(exit.value)
    : failed(Option.getOrElse(Cause.findErrorOption(exit.cause), () => Cause.squash(exit.cause)))

const required = (url: URL, name: string): string => {
  const value = url.searchParams.get(name)
  if (value === null) throw new InvalidInput({ reason: `missing ${name}` })
  return value
}

/** A download of a stored file: its bytes as stored, an attachment unless it is a plain image. */
function download(name: string, mimeType: string, body: ReadableStream<Uint8Array>): Response {
  const inline = INLINE.has(mimeType)
  return new Response(body, {
    headers: {
      'content-type': inline ? mimeType : 'application/octet-stream',
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    },
  })
}

/** Writes the request's body to `path`: it must say how long it is, and be within the per-file limit. */
async function upload(request: Request, path: string, execute: ExitProgram): Promise<Response> {
  const declared = request.headers.get('content-length')
  const size = declared === null ? Number.NaN : Number(declared)
  if (!Number.isSafeInteger(size) || request.body === null) throw new InvalidInput({ reason: 'file size' })
  if (size > FILE_LIMITS.fileBytes) throw new PayloadTooLarge({ limit: FILE_LIMITS.fileBytes })
  const mimeType = (request.headers.get('content-type') ?? 'application/octet-stream').slice(0, 128)
  const body = request.body
  const exit = await execute(Files.use((files) => files.write('owner', path, body, mimeType, size)))
  return answer(exit, (entry) => Response.json(entry, { status: 201 }))
}

/** One file: `GET` downloads it, `PUT` writes it, `DELETE` deletes it. */
async function content(request: Request, path: string, execute: ExitProgram): Promise<Response> {
  switch (request.method) {
    case 'GET': {
      const exit = await execute(Files.use((files) => files.read(path)))
      return answer(exit, ({ entry, body }) => download(entry.name, entry.mimeType, body))
    }
    case 'DELETE': {
      const exit = await execute(Files.use((files) => files.remove('owner', path)))
      return answer(exit, () => Response.json({ deleted: true }))
    }
    case 'PUT':
      return upload(request, path, execute)
    default:
      return Response.json({ error: 'NotFound' }, { status: 404 })
  }
}

/**
 * The owner's files, as the Worker forwards them after authenticating the owner: `GET /api/files?dir=` lists, and
 * `/api/files/content?path=` reads (`GET`), writes (`PUT`, the request's body, `content-length` required) or deletes.
 */
export async function filesRequest(request: Request, url: URL, execute: ExitProgram): Promise<Response> {
  try {
    if (url.pathname === '/api/files/content') return await content(request, required(url, 'path'), execute)
    if (url.pathname !== '/api/files' || request.method !== 'GET')
      return Response.json({ error: 'NotFound' }, { status: 404 })
    const dir = url.searchParams.get('dir') ?? '/uploads'
    return answer(await execute(Files.use((files) => files.list(dir))), (listing) => Response.json(listing))
  } catch (cause) {
    // expected: a refused request (no path, no size, too large) is answered with its error body; toAppError logs any
    // other failure before it becomes Internal
    return failed(cause)
  }
}
