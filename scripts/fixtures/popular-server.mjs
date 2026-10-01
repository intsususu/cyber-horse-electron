// 隔离桌面验收使用的 Emby 响应，不读取个人服务器或媒体。
export async function installPopularServer(app) {
  const page = await app.firstWindow()
  // 测试图片只用于隔离验收，让截图可以核对海报拼接与头像裁切。
  const artwork = await page.evaluate(() => {
    const colors = ['#657f7b', '#bf875d', '#6b7896', '#948578']
    const png = (number, avatar) => {
      const canvas = document.createElement('canvas')
      canvas.width = 240
      canvas.height = avatar ? 240 : 360
      const context = canvas.getContext('2d')
      context.fillStyle = colors[number % colors.length]
      context.fillRect(0, 0, canvas.width, canvas.height)
      if (avatar) {
        context.fillStyle = '#333c49'
        context.beginPath()
        context.ellipse(120, 233, 90, 84, 0, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = '#e7bea0'
        context.beginPath()
        context.ellipse(120, 102, 49, 65, 0, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = '#303333'
        context.beginPath()
        context.ellipse(117, 58, 54, 38, -0.2, Math.PI, Math.PI * 2)
        context.fill()
      } else {
        context.fillStyle = '#e9d7b0'
        context.beginPath()
        context.arc(172, 83, 32, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = '#324d55'
        context.beginPath()
        context.moveTo(0, 240)
        context.lineTo(100, 130 + number * 5)
        context.lineTo(240, 265)
        context.lineTo(240, 360)
        context.lineTo(0, 360)
        context.fill()
        context.fillStyle = '#f7efe0'
        context.font = 'bold 38px serif'
        context.fillText(['山间', '潮声', '远行', '晴日'][number % 4], 25, 285)
        context.font = '16px sans-serif'
        context.fillText('隔离测试海报', 25, 318)
      }
      return canvas.toDataURL('image/png').split(',')[1]
    }
    return {
      posters: colors.map((_, i) => png(i, false)),
      avatars: colors.map((_, i) => png(i, true)),
    }
  })
  await app.evaluate((_, artwork) => {
    const actors = [
      '林遥',
      '陈序',
      '许知夏',
      '沈予安',
      '周南',
      '叶青',
      '江澄',
      '顾言',
      '程溪',
      '陆星',
      '宋安',
      '温宁',
      '苏禾',
      '白川',
      '徐风',
    ]
    const series = [
      '山海之间',
      '城市漫游',
      '四季来信',
      '旅途纪事',
      '日常片段',
      '光影拾遗',
      '时光档案',
      '周末故事',
      '海边往事',
      '深夜电台',
      '山间行记',
      '远方的灯',
      '春日手札',
      '漫长的告别与重逢：那些留在记忆里的城市和未曾寄出的信',
      '一日之间',
    ]
    const items = Array.from({ length: 31 }, (_, index) => ({
      Id: `v${index + 1}`,
      Name: `影片 ${String(index + 1).padStart(2, '0')}`,
      ProductionYear: 2025,
      DateCreated: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
      RunTimeTicks: 60000000000,
      Overview: '隔离测试影片详情。',
      Genres: index % 2 === 0 ? ['剧情'] : ['纪实'],
      UserData: {
        PlayCount: 31 - index,
        IsFavorite: index % 3 === 0,
        LastPlayedDate: new Date(Date.UTC(2026, 2, index + 1)).toISOString(),
      },
      People: [
        { Id: 'p1', Name: actors[0], Type: 'Actor' },
        ...(index > 0 && index < 15
          ? [{ Id: `p${index + 1}`, Name: actors[index], Type: 'Actor' }]
          : []),
      ],
    }))
    globalThis.popularImageRequests = 0
    globalThis.popularImagePaths = []
    globalThis.popularMediaQueries = []
    globalThis.popularFilterFailure = false
    globalThis.fetch = async (input, init) => {
      const url = new URL(input)
      const path = url.pathname
      if (path.endsWith('/AuthenticateByName'))
        return Response.json({
          AccessToken: 'fixture-token',
          ServerId: 'fixture-server',
          User: { Id: 'u1' },
        })
      if (init?.method && init.method !== 'GET') throw new Error('热门扫描不应修改服务器数据')
      if (path.endsWith('/Views'))
        return Response.json({
          Items: [
            { Id: 'lib1', Name: '空媒体库', CollectionType: 'movies' },
            { Id: 'lib2', Name: '隔离媒体库', CollectionType: 'movies' },
          ],
        })
      if (path.endsWith('/Items')) {
        globalThis.popularMediaQueries.push(Object.fromEntries(url.searchParams))
        if (
          globalThis.popularFilterFailure &&
          (url.searchParams.has('Genres') || url.searchParams.has('PersonIds'))
        )
          return new Response(null, { status: 500 })
        let rows = items
        if (url.searchParams.get('IncludeItemTypes') === 'BoxSet')
          rows = series.map((Name, index) => ({ Id: `c${index + 1}`, Name }))
        else if (url.searchParams.has('Ids'))
          rows = url.searchParams
            .get('Ids')
            .split(',')
            .map((id) => items.find((item) => item.Id === id))
            .filter(Boolean)
        else if (url.searchParams.has('ParentId')) {
          const parent = url.searchParams.get('ParentId')
          const offset = Number(parent.slice(1)) - 1
          rows =
            parent === 'lib1'
              ? []
              : parent === 'lib2' || parent === 'c1'
                ? items
                : items.slice(offset, offset + 4)
        }
        if (url.searchParams.has('Genres'))
          rows = rows.filter((item) => item.Genres?.includes(url.searchParams.get('Genres')))
        if (url.searchParams.has('PersonIds'))
          rows = rows.filter((item) =>
            item.People?.some((person) => person.Id === url.searchParams.get('PersonIds')),
          )
        const start = Number(url.searchParams.get('StartIndex') ?? 0)
        return Response.json({
          Items: rows.slice(start, start + Number(url.searchParams.get('Limit') ?? 500)),
          TotalRecordCount: rows.length,
        })
      }
      if (/\/Items\/v\d+$/.test(path))
        return Response.json(items.find((item) => path.endsWith(`/${item.Id}`)))
      if (path.endsWith('/Similar')) return Response.json({ Items: [], TotalRecordCount: 0 })
      if (path.includes('/Images/')) {
        globalThis.popularImageRequests++
        globalThis.popularImagePaths.push(path)
        const id = /\/Items\/(p|v)(\d+)\/Images\/Primary/.exec(path)
        if (!id || (id[1] === 'p' && id[2] === '3')) return new Response(null, { status: 404 })
        const source = id[1] === 'p' ? artwork.avatars : artwork.posters
        return new Response(Buffer.from(source[Number(id[2]) % source.length], 'base64'), {
          headers: { 'content-type': 'image/png' },
        })
      }
      return new Response(null, { status: 404 })
    }
  }, artwork)
}
