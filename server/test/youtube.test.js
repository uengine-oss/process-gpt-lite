// YouTube connector: which credential the Data API tools use and in what order, what they return,
// what a run without any credential is told, and the no-key paths (results page, channel RSS) —
// all with a stubbed fetch, no network.
import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { youtube, deps, searchFilter, sinceOf, countOf, categoryId, parseFeed, pageVideos, jsonAfter } from '../mcp/connectors/youtube.js'

const tool = (name) => youtube.tools.find((t) => t.name === name).run
const saved = { ...deps }
afterEach(() => { Object.assign(deps, saved) })

// creds: { vault, server, google: { scoped, token } | null }; routes: [regex, (url, init) => Response]
function stub({ vault = null, server = '', google = null, googleEnabled = true } = {}, routes = []) {
  const calls = []
  deps.vaultKey = async () => vault
  deps.serverKey = () => server
  deps.google = async () => google
  deps.googleEnabled = () => googleEnabled
  deps.ytdlp = async () => { throw Object.assign(new Error('yt-dlp missing'), { code: 'ENOENT' }) }
  deps.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), auth: init.headers?.Authorization || null, key: new URL(url).searchParams.get('key') })
    const r = routes.find(([re]) => re.test(String(url)))
    if (!r) throw new Error(`unexpected fetch ${url}`)
    return r[1](String(url), init)
  }
  return calls
}

const denied = () => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Permission denied on the service.', errors: [{ reason: 'forbidden' }], details: [{ reason: 'ACCESS_DENIED' }] } }, { status: 403 })
const item = (id, views, likes) => ({
  id, snippet: { title: `제목 ${id}`, channelTitle: `채널 ${id}`, channelId: `UC${id}`, publishedAt: '2026-11-18T00:00:00Z', thumbnails: { default: { url: 'd.jpg' }, high: { url: `${id}-high.jpg` } } },
  statistics: { viewCount: String(views), likeCount: likes == null ? undefined : String(likes), commentCount: '7' }, contentDetails: { duration: 'PT4M2S' },
})

test('trending: vault key first, then the server key, then the Google account', async () => {
  const calls = stub({ vault: 'VK', server: 'SK', google: { scoped: true, token: async () => 'AT' } }, [
    [/key=VK/, denied],
    [/key=SK/, () => Response.json({ items: [item('a1', 1200, 30), item('b2', 900, null)] })],
  ])
  const out = await tool('youtube_trending')('u1', {})
  assert.deepEqual(calls.map((c) => c.key || c.auth), ['VK', 'SK'])
  assert.equal(out.credential, 'server_key')
  assert.equal(out.region, 'KR')
  const u = new URL(calls[1].url)
  assert.equal(u.pathname, '/youtube/v3/videos')
  assert.equal(u.searchParams.get('chart'), 'mostPopular')
  assert.equal(u.searchParams.get('regionCode'), 'KR')
  assert.deepEqual(out.videos[0], {
    rank: 1, id: 'a1', title: '제목 a1', channel: '채널 a1', channel_id: 'UCa1', views: 1200, likes: 30, comments: 7,
    published_at: '2026-11-18T00:00:00Z', duration: 'PT4M2S', url: 'https://www.youtube.com/watch?v=a1', thumbnail: 'a1-high.jpg',
  })
  assert.equal(out.videos[1].likes, null) // hidden like count stays unknown, not 0
})

test('trending: the Google account (Bearer) when there is no key, with region and category', async () => {
  const calls = stub({ google: { scoped: true, token: async () => 'AT' } }, [
    [/\/videos\?/, () => Response.json({ items: [item('c3', 5, 1)] })],
  ])
  const out = await tool('youtube_trending')('u1', { region: 'us', category: '10', max: 3 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].auth, 'Bearer AT')
  assert.equal(calls[0].key, null)
  const p = new URL(calls[0].url).searchParams
  assert.equal(p.get('regionCode'), 'US')
  assert.equal(p.get('videoCategoryId'), '10')
  assert.equal(p.get('maxResults'), '3')
  assert.equal(out.credential, 'google_oauth')
})

test('trending without any credential and no public page: says exactly what is missing and where to connect it', async () => {
  const calls = stub({}, [[/youtube\.com\/results/, () => new Response('', { status: 429 })]])
  await assert.rejects(tool('youtube_trending')('u1', {}), (e) => {
    assert.equal(e.detail.error, 'youtube_api_unavailable')
    assert.equal(e.detail.missing.length, 2)
    assert.match(e.detail.missing.join(' '), /API 키/)
    assert.match(e.detail.missing.join(' '), /Google 계정/)
    assert.match(e.detail.how_to_connect, /설정 › 계정 › 연결 › YouTube/)
    assert.match(e.detail.how_to_connect, /console\.cloud\.google\.com/)
    assert.match(e.detail.admin, /PRO_YOUTUBE_API_KEY/)
    assert.match(e.detail.public_page_error, /429/)
    assert.deepEqual(e.detail.tried, [])
    return true
  })
  assert.ok(calls.every((c) => !/googleapis/.test(c.url))) // no credential: the API is never called
})

test('trending without any credential: the public approximation, labelled, with what is missing', async () => {
  const pages = { '뉴스·정치': [renderer('n1', '조회수 9,000회', '2시간 전'), renderer('m1', '조회수 3,000회', '1시간 전')], 음악: [renderer('m1', '조회수 3,000회', '1시간 전'), renderer('m2', '조회수 12만회', '5시간 전')] }
  const calls = stub({}, [[/youtube\.com\/results/, (url) => new Response(resultsPage(pages[new URL(url).searchParams.get('search_query')] || []))]])
  const out = await tool('youtube_trending')('u1', { max: 3 })
  const queries = calls.map((c) => new URL(c.url).searchParams.get('search_query'))
  // (the broad spread is the category table's own labels, not a word list)
  assert.deepEqual(queries.sort(), ['게임', '뉴스·정치', '스포츠', '엔터테인먼트', '음악'].sort())
  assert.equal(new URL(calls[0].url).searchParams.get('sp'), searchFilter('viewCount', new Date(Date.now() - 86400e3)))
  assert.equal(out.source, 'public_search_page')
  assert.equal(out.exact_chart, false)
  assert.match(out.basis, /정식 인기 차트가 아니에요/)
  assert.match(out.how_to_connect, /설정 › 계정 › 연결 › YouTube/)
  assert.equal(out.api_missing.length, 2)
  assert.deepEqual(out.videos.map((v) => [v.rank, v.id, v.views]), [[1, 'm2', 120000], [2, 'n1', 9000], [3, 'm1', 3000]])
  // a category asked for is the one search
  const one = stub({}, [[/youtube\.com\/results/, () => new Response(resultsPage(pages.음악))]])
  await tool('youtube_trending')('u1', { category: '10' })
  assert.deepEqual(one.map((c) => new URL(c.url).searchParams.get('search_query')), ['음악'])
})

test('a Google account without YouTube access and a key the project cannot use: both reasons are told', async () => {
  stub({ vault: 'VK', google: { scoped: false, token: async () => 'AT' }, googleEnabled: false }, [[/key=VK/, denied]])
  await assert.rejects(tool('youtube_trending')('u1', {}), (e) => {
    assert.deepEqual(e.detail.missing, []) // both are there; they just do not work
    assert.equal(e.detail.tried.length, 2)
    assert.match(e.detail.tried[0].reason, /YouTube Data API v3/)
    assert.match(e.detail.tried[1].reason, /youtube\.readonly/)
    assert.doesNotMatch(e.detail.how_to_connect, /Google 「연결」/) // this server has no Google sign-in
    return true
  })
})

test('a bad argument is an error, not a reason to try the next credential', async () => {
  const calls = stub({ vault: 'VK', server: 'SK' }, [[/videos/, () => Response.json({ error: { code: 400, message: 'Invalid region code', errors: [{ reason: 'invalidRegionCode' }] } }, { status: 400 })]])
  await assert.rejects(tool('youtube_trending')('u1', { region: 'ZZ' }), /Invalid region code/)
  assert.equal(calls.length, 1)
})

test('search: search ids, then their statistics, in the search order', async () => {
  const calls = stub({ vault: 'VK' }, [
    [/\/search\?/, () => Response.json({ items: [{ id: { videoId: 'x2' } }, { id: { videoId: 'x1' } }] })],
    [/\/videos\?/, () => Response.json({ items: [item('x1', 10, 1), item('x2', 20, 2)] })],
  ])
  const now = Date.now()
  const out = await tool('youtube_search')('u1', { query: '뉴스', publishedAfter: '24h', max: 2 })
  const s = new URL(calls[0].url).searchParams
  assert.equal(s.get('q'), '뉴스')
  assert.equal(s.get('order'), 'viewCount')
  assert.equal(s.get('type'), 'video')
  assert.ok(Math.abs(new Date(s.get('publishedAfter')).getTime() - (now - 86400e3)) < 5000)
  assert.equal(new URL(calls[1].url).searchParams.get('id'), 'x2,x1')
  assert.deepEqual(out.videos.map((v) => [v.rank, v.id, v.views, v.likes]), [[1, 'x2', 20, 2], [2, 'x1', 10, 1]])
  assert.equal(out.source, 'youtube_data_api')
})

// a results page as YouTube serves it: the data is a script assignment inside the HTML
const resultsPage = (renderers) => `<html><script>var ytInitialData = ${JSON.stringify({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: renderers } }] } } } } })};</script></html>`
const renderer = (id, views, when) => ({ videoRenderer: {
  videoId: id, title: { runs: [{ text: `영상 ${id} "따옴표" }` }] }, ownerText: { runs: [{ text: `채널${id}`, navigationEndpoint: { browseEndpoint: { browseId: `UC${id}` } } }] },
  viewCountText: { simpleText: views }, publishedTimeText: { simpleText: when }, lengthText: { simpleText: '3:21' }, thumbnail: { thumbnails: [{ url: 's.jpg' }, { url: `${id}.jpg` }] },
} })

test('search without a key: the public results page, sorted by views, with what is missing for the API', async () => {
  const calls = stub({}, [[/youtube\.com\/results/, () => new Response(resultsPage([renderer('p1', '조회수 1,203회', '3시간 전'), { adSlotRenderer: {} }, renderer('p2', '조회수 1.5만회', '1시간 전'), renderer('p1', '조회수 1,203회', '3시간 전')]))]])
  const out = await tool('youtube_search')('u1', { query: '경제', publishedAfter: 'today' })
  assert.equal(calls.length, 1)
  const u = new URL(calls[0].url)
  assert.equal(u.searchParams.get('search_query'), '경제')
  assert.equal(out.source, 'public_search_page')
  assert.match(out.how_to_connect, /설정 › 계정 › 연결/)
  assert.ok(out.api_missing.length)
  assert.deepEqual(out.videos.map((v) => [v.rank, v.id, v.views, v.channel, v.channel_id, v.published]), [[1, 'p2', 15000, '채널p2', 'UCp2', '1시간 전'], [2, 'p1', 1203, '채널p1', 'UCp1', '3시간 전']])
  assert.equal(out.videos[0].title, '영상 p2 "따옴표" }')
  assert.equal(out.videos[0].url, 'https://www.youtube.com/watch?v=p2')
  assert.equal(out.videos[0].thumbnail, 'p2.jpg')
})

test('the newer results layout (lockupViewModel): channel from the byline link, views from the label', () => {
  const byline = { text: { content: 'MBCNEWS', commandRuns: [{ onTap: { innertubeCommand: { browseEndpoint: { browseId: 'UCF4Wxdo3inmxP-Y59wXDsFw' } } } }] } }
  const lockup = { lockupViewModel: { contentId: 'k1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: { thumbnailViewModel: { image: { sources: [{ url: 'a.jpg' }, { url: 'k1.jpg' }] }, overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: '3:02' } }] } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: '자막뉴스' }, metadata: { contentMetadataViewModel: { metadataRows: [
      { metadataParts: [byline, { text: { content: '193만' }, accessibilityLabel: '조회수 193만회' }, { text: { content: '13시간 전' }, accessibilityLabel: '13시간 전' }] },
      { isSpacerRow: true }, { metadataParts: [{ text: { content: '#뉴스 #MBC' } }] },
    ] } } } } } }
  assert.deepEqual(pageVideos({ contents: [lockup] })[0], {
    id: 'k1', title: '자막뉴스', channel: 'MBCNEWS', channel_id: 'UCF4Wxdo3inmxP-Y59wXDsFw', views: 1930000, views_text: '조회수 193만회', likes: null,
    published: '13시간 전', duration: '3:02', url: 'https://www.youtube.com/watch?v=k1', thumbnail: 'k1.jpg',
  })
})

test('search without a key when the public page fails too: the setup error carries both', async () => {
  stub({}, [[/youtube\.com\/results/, () => new Response('nope', { status: 503 })]])
  await assert.rejects(tool('youtube_search')('u1', { query: 'x' }), (e) => {
    assert.equal(e.detail.error, 'youtube_api_unavailable')
    assert.match(e.detail.public_page_error, /503/)
    return true
  })
})

const feed = `<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
 <title>경제사냥꾼</title><link rel="alternate" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"/>
 <entry><id>yt:video:v1</id><yt:videoId>v1</yt:videoId><title>11월 FOMC &amp; 환율</title><published>2026-11-17T21:41:58+00:00</published>
  <media:group><media:title>11월 FOMC &amp; 환율</media:title><media:thumbnail url="https://i.ytimg.com/vi/v1/hqdefault.jpg" width="480" height="360"/>
  <media:description>요약</media:description><media:community><media:starRating count="321" average="5.00" min="1" max="5"/><media:statistics views="45678"/></media:community></media:group></entry>
 <entry><yt:videoId>v2</yt:videoId><title>둘째</title><published>2026-11-16T01:00:00+00:00</published><media:statistics views="12"/></entry>
</feed>`

test('channel videos without yt-dlp: @handle → channel id from the channel page → its RSS feed', async () => {
  const calls = stub({}, [
    [/youtube\.com\/@/, () => new Response('<link rel="canonical" href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"><meta property="og:title" content="경제사냥꾼">')],
    [/feeds\/videos\.xml\?channel_id=UCabcdefghijklmnopqrstuv/, () => new Response(feed)],
  ])
  const out = await tool('youtube_channel_videos')('u1', { channel: '@경제사냥꾼', limit: 5 })
  assert.equal(new URL(calls[0].url).pathname, `/@${encodeURIComponent('경제사냥꾼')}`)
  assert.equal(out.source, 'rss')
  assert.equal(out.channel, '경제사냥꾼')
  assert.equal(out.channel_id, 'UCabcdefghijklmnopqrstuv')
  assert.deepEqual(out.videos[0], {
    id: 'v1', title: '11월 FOMC & 환율', url: 'https://www.youtube.com/watch?v=v1', published_at: '2026-11-17T21:41:58+00:00', upload_date: '20261118',
    views: 45678, likes: 321, thumbnail: 'https://i.ytimg.com/vi/v1/hqdefault.jpg', description: '요약',
  })
  assert.deepEqual([out.videos[1].views, out.videos[1].likes], [12, null])
})

test('channel videos: a channel id goes straight to RSS; RSS 404 falls back to yt-dlp', async () => {
  const calls = stub({}, [[/feeds\/videos\.xml/, () => new Response('', { status: 404 })]])
  deps.ytdlp = async (args) => JSON.stringify({ channel: 'C', channel_id: 'UCabcdefghijklmnopqrstuv', entries: [{ id: 'y1', title: 't', upload_date: '20261118', view_count: 3 }], args })
  const out = await tool('youtube_channel_videos')('u1', { channel: 'UCabcdefghijklmnopqrstuv' })
  assert.equal(calls.length, 1)
  assert.equal(out.source, 'yt-dlp')
  assert.deepEqual(out.videos[0], { id: 'y1', title: 't', url: 'https://www.youtube.com/watch?v=y1', duration: undefined, upload_date: '20261118', views: 3 })
})

test('helpers: results filter, relative dates, counts, categories, embedded JSON', () => {
  const now = new Date('2026-11-18T03:00:00Z')
  assert.equal(searchFilter('viewCount', new Date(now.getTime() - 20 * 3600e3), now), 'CAMSBAgCEAE=') // views, today, videos
  assert.equal(searchFilter('date', null, now), 'CAISAhAB')
  assert.equal(searchFilter('relevance', new Date(now.getTime() - 3 * 86400e3), now), 'EgQIAxAB')
  assert.equal(sinceOf('7d', now).toISOString(), '2026-11-11T03:00:00.000Z')
  assert.equal(sinceOf('2026-11-18').toISOString(), '2026-11-17T15:00:00.000Z')
  assert.equal(sinceOf('today', now), null, 'words are the model\'s to turn into the format')
  assert.equal(sinceOf('nonsense'), null)
  assert.equal(countOf('조회수 1,103,049회'), 1103049)
  assert.equal(countOf('조회수 3.4만회'), 34000)
  assert.equal(countOf('1.2M views'), 1200000)
  assert.equal(countOf('조회수 없음'), 0)
  assert.equal(categoryId('게임'), null, 'a word is not an id: the tool description lists the ids')
  assert.equal(categoryId('25'), '25')
  assert.equal(categoryId('17'), '17')
  assert.equal(categoryId('99'), null)
  assert.deepEqual(jsonAfter('x var a = {"s":"}{\\"","n":{"m":1}}; var b', 'var a = '), { s: '}{"', n: { m: 1 } })
  assert.equal(parseFeed('<feed><title>t</title></feed>').videos.length, 0)
  assert.deepEqual(pageVideos({ a: [{ lockupViewModel: { contentId: 'L1', contentType: 'LOCKUP_CONTENT_TYPE_VIDEO', metadata: { lockupMetadataViewModel: { title: { content: '록업' },
    metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: '조회수 41회' } }, { text: { content: '5분 전' } }] }] } } } } } }] }).map((v) => [v.id, v.title, v.views, v.published]), [['L1', '록업', 41, '5분 전']])
})
