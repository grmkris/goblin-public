// Charts for an app's view (`charts.js`): Recharts itself and the kit's Chart, on core's React.
import { Chart } from '@goblin/kit/chart'
import * as recharts from 'recharts'
import { provide } from './modules.ts'

provide({ recharts, '@goblin/kit/chart': { Chart } })
