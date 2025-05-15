const socket = io()
let last = null
let prev = null

socket.on('state', s => {
  prev = last
  last = { time: Date.now(), pos: s.pos }
})

setInterval(() => {
  sendInput()
  draw()
}, 33)

function sendInput() {
  let dir = { x: 0, y: 0, z: 0 }
  if (keys.w) dir.z -= 1
  if (keys.s) dir.z += 1
  if (keys.a) dir.x -= 1
  if (keys.d) dir.x += 1
  socket.emit('input', { t: Date.now(), dir })
}

function draw() {
  if (!prev || !last) return
  let now = Date.now()
  let dt = (now - last.time) / 100
  let pos = lerp(prev.pos, last.pos, dt)
  render(pos)
}

function lerp(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  }
}