import { checkOperation as checkProgram } from '../services/programs/check.ts'
import { answerWith, type ApiCall } from './call.ts'

/** `POST /api/operations/:operationId/check`: the owner asks the chain how an uncertain operation ended. */
export const checkOperation = (call: ApiCall): Promise<Response> =>
  answerWith(call, checkProgram(call.params['operationId'] ?? ''))
