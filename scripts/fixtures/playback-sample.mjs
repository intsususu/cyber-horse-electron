// 在隔离桌面中编码纯色测试画面，不读取或保存真实媒体。
export async function playbackSample(page) {
  const frames = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    const context = canvas.getContext('2d')
    const chunks = []
    let failure
    const encoder = new VideoEncoder({
      output(chunk) {
        const data = new Uint8Array(chunk.byteLength)
        chunk.copyTo(data)
        chunks.push(Array.from(data))
      },
      error(error) {
        failure = error
      },
    })
    encoder.configure({ codec: 'vp8', width: 320, height: 180, bitrate: 64000, framerate: 1 })
    for (let i = 0; i < 90; i++) {
      context.fillStyle = '#25342f'
      context.fillRect(0, 0, 320, 180)
      context.fillStyle = '#e5ede8'
      context.font = '20px sans-serif'
      context.fillText('播放交互测试', 90, 82)
      context.font = '16px sans-serif'
      context.fillText(`${i} / 90 秒`, 120, 115)
      const frame = new VideoFrame(canvas, { timestamp: i * 1000000, duration: 1000000 })
      encoder.encode(frame, { keyFrame: true })
      frame.close()
    }
    await encoder.flush()
    encoder.close()
    if (failure) throw failure
    return chunks
  })
  const size = (value) => {
    for (let length = 1; length <= 6; length++) {
      if (value < 2 ** (7 * length) - 1) {
        const result = Buffer.alloc(length)
        result.writeUIntBE(value, 0, length)
        result[0] |= 1 << (8 - length)
        return result
      }
    }
    throw new Error('测试视频过大。')
  }
  const uint = (value) => {
    const buffer = Buffer.alloc(4)
    buffer.writeUInt32BE(value)
    return buffer
  }
  const element = (id, ...data) => {
    const payload = Buffer.concat(data)
    return Buffer.concat([Buffer.from(id, 'hex'), size(payload.length), payload])
  }
  const number = (id, value) => element(id, uint(value))
  const text = (id, value) => element(id, Buffer.from(value))
  const duration = Buffer.alloc(8)
  duration.writeDoubleBE(90000)
  const header = element(
    '1a45dfa3',
    number('4286', 1),
    number('42f7', 1),
    number('42f2', 4),
    number('42f3', 8),
    text('4282', 'webm'),
    number('4287', 2),
    number('4285', 2),
  )
  const info = element(
    '1549a966',
    number('2ad7b1', 1000000),
    text('4d80', 'Cyber Horse 测试'),
    text('5741', 'Cyber Horse 测试'),
    element('4489', duration),
  )
  const tracks = element(
    '1654ae6b',
    element(
      'ae',
      number('d7', 1),
      number('73c5', 1),
      number('83', 1),
      text('86', 'V_VP8'),
      element('e0', number('b0', 320), number('ba', 180)),
    ),
  )
  const clusters = frames.map((frame, index) =>
    element(
      '1f43b675',
      number('e7', index * 1000),
      element('a3', Buffer.from([0x81, 0, 0, 0x80]), Buffer.from(frame)),
    ),
  )
  let position = info.length + tracks.length
  const cues = clusters.map((cluster, index) => {
    const cue = element(
      'bb',
      number('b3', index * 1000),
      element('b7', number('f7', 1), number('f1', position)),
    )
    position += cluster.length
    return cue
  })
  return Buffer.concat([
    header,
    element('18538067', info, tracks, ...clusters, element('1c53bb6b', ...cues)),
  ])
}
