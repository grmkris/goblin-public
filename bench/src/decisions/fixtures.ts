import { Schema } from 'effect'
import data from '../../fixtures/decisions.json'
import { Fixture } from './schema.ts'

/** Frozen synthetic labels stay on the coordinator; only state/questions reach providers. */
export const decisionFixtures = Schema.decodeUnknownSync(Schema.Array(Fixture))(data)
