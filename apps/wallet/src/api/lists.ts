import { json } from '../http.ts'
import { listServices } from '../services/programs/services-list.ts'
import { answerWith, type ApiCall } from './call.ts'

export const activity = async (call: ApiCall): Promise<Response> => json(await call.ledger.activity(50))

export const addressBook = async (call: ApiCall): Promise<Response> => json(await call.ledger.recipients())

export const services = (call: ApiCall): Promise<Response> => answerWith(call, listServices)
