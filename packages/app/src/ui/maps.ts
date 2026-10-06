// Maps for an app's view (`maps.js`, with `maps.css`): Leaflet, react-leaflet and the kit's MapView, on core's React.
// Tiles come from OpenStreetMap, the one host an app's frame may load images from.
import { MapView } from '@goblin/kit/map'
import * as leaflet from 'leaflet'
import * as reactLeaflet from 'react-leaflet'
import { provide } from './modules.ts'

provide({ leaflet, 'react-leaflet': reactLeaflet, '@goblin/kit/map': { MapView } })
