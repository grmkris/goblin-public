import 'leaflet/dist/leaflet.css'
import { latLngBounds } from 'leaflet'
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from 'react-leaflet'
import { type MapSpec, mapPoints } from './specs.ts'
import { useTheme } from './theme.ts'

/** CARTO's raster basemaps over OpenStreetMap data, light or dark with the theme. */
const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
} as const
const ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'

const color = (index: number) => `var(--chart-${(index % 5) + 1})`
const PADDING: [number, number] = [24, 24]
const latLng = ([lat, lng]: readonly [number, number]): [number, number] => [lat, lng]

/** Where the map opens: fitted around everything it shows, or at its center and zoom. */
function view(spec: MapSpec) {
  const points = mapPoints(spec)
  if (spec.zoom === undefined && points.length > 1)
    return { bounds: latLngBounds(points.map(latLng)), boundsOptions: { padding: PADDING } }
  return { center: latLng(points[0] ?? [0, 0]), zoom: spec.zoom ?? 11 }
}

/** A map drawn from a spec: markers in the first chart colour, each line in the next; labels show on hover. */
export function MapView({ spec }: { readonly spec: MapSpec }) {
  const theme = useTheme()
  return (
    <figure className="kit-map">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <MapContainer className="kit-map-canvas" scrollWheelZoom={false} {...view(spec)}>
        <TileLayer key={theme} url={TILES[theme]} attribution={ATTRIBUTION} subdomains="abcd" />
        {(spec.lines ?? []).map((line, index) => (
          <Polyline
            key={`line-${index}`}
            positions={line.points.map(latLng)}
            pathOptions={{ color: color(index + 1), weight: 3 }}
          >
            {line.label !== undefined && <Tooltip sticky>{line.label}</Tooltip>}
          </Polyline>
        ))}
        {(spec.markers ?? []).map((marker, index) => (
          <CircleMarker
            key={`marker-${index}`}
            center={[marker.lat, marker.lng]}
            radius={7}
            pathOptions={{ color: 'var(--background)', weight: 2, fillColor: color(0), fillOpacity: 1 }}
          >
            {marker.label !== undefined && <Tooltip>{marker.label}</Tooltip>}
          </CircleMarker>
        ))}
      </MapContainer>
    </figure>
  )
}
