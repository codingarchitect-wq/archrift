// The Transit view's key: what stations, interchanges and lines stand for.
const dot = (size: number, ring: string) => ({ width: size, height: size, borderRadius: '50%', background: '#fff', boxShadow: `inset 0 0 0 ${ring}` })

export function Legend() {
  return (
    <div className="swatches">
      <span>
        <i style={dot(10, '2px #8b949e')} />
        station: a file
      </span>
      <span>
        <i style={dot(13, '3px #1f2328')} />
        interchange: a file several lines share
      </span>
      <span className="dim">each line runs from a page down to the data it reaches; choose lines in the toolbar</span>
    </div>
  )
}
