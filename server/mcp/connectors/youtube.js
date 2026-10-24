// YouTube: recent channel uploads and transcripts. Public data, fetched server-side with yt-dlp
// (handles both @handles and channel ids, no API quota, auto-generated captions included).
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'

// Korean metadata instead of YouTube's auto-translated titles
const BASE = ['--extractor-args', 'youtube:lang=ko', '--no-warnings']
const run = (args, timeout = 120000) => new Promise((resolve, reject) => {
  execFile('yt-dlp', [...BASE, ...args], { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).split('\n').filter(Boolean).slice(-2).join(' '))) : resolve(stdout))
})

function channelUrl(channel) {
  const c = String(channel).trim()
  if (/^https?:\/\//.test(c)) return c.replace(/\/$/, '') + (/\/(videos|streams|shorts)$/.test(c) ? '' : '/videos')
  if (c.startsWith('@')) return `https://www.youtube.com/${c}/videos`
  if (/^UC[\w-]{22}$/.test(c)) return `https://www.youtube.com/channel/${c}/videos`
  return `https://www.youtube.com/@${c}/videos`
}

// WebVTT auto-captions repeat each line as it scrolls; keep each sentence once.
function vttToText(vtt) {
  const out = []
  let last = ''
  for (const raw of vtt.split('\n')) {
    const line = raw.replace(/<[^>]+>/g, '').trim()
    if (!line || line === 'WEBVTT' || /^(Kind|Language):/.test(line) || /-->/.test(line) || /^\d+$/.test(line)) continue
    if (line === last || last.endsWith(line)) continue
    out.push(line)
    last = line
  }
  return out.join(' ').replace(/\s+/g, ' ').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
}

export const youtube = {
  name: 'youtube',
  title: 'YouTube',
  connected: async () => true, // public data
  tools: [
    {
      name: 'youtube_channel_videos',
      description: 'List the most recent uploads of a YouTube channel (handle like @name, channel id, or URL). Returns id, title, url, upload date when known.',
      input: { channel: z.string(), limit: z.number().int().min(1).max(30).optional() },
      run: async (_u, { channel, limit = 10 }) => {
        const out = await run(['--flat-playlist', '-J', '--playlist-end', String(limit), channelUrl(channel)])
        const j = JSON.parse(out)
        return {
          channel: j.channel || j.uploader || j.title, channel_id: j.channel_id,
          videos: (j.entries || []).map((e) => ({ id: e.id, title: e.title, url: `https://www.youtube.com/watch?v=${e.id}`, duration: e.duration, upload_date: e.upload_date || null })),
        }
      },
    },
    {
      name: 'youtube_video_info',
      description: 'Title, upload date, duration and description of one video.',
      input: { videoId: z.string() },
      run: async (_u, { videoId }) => {
        const j = JSON.parse(await run(['-J', '--skip-download', `https://www.youtube.com/watch?v=${videoId}`]))
        return { id: j.id, title: j.title, upload_date: j.upload_date, duration: j.duration, channel: j.channel, description: (j.description || '').slice(0, 4000) }
      },
    },
    {
      name: 'youtube_transcript',
      description: 'Transcript text of a video from its captions (manual or auto-generated). lang defaults to ko, falls back to en.',
      input: { videoId: z.string(), lang: z.string().optional() },
      run: async (_u, { videoId, lang = 'ko' }) => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pro-yt-'))
        try {
          // one language per request: asking for several at once trips YouTube's 429 on the extra tracks
          for (const l of [`${lang}-orig`, lang, 'en']) {
            try {
              await run(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', l, '--sub-format', 'vtt',
                '-o', path.join(dir, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${videoId}`])
            } catch { continue }
            if ((await fs.readdir(dir)).some((f) => f.endsWith('.vtt'))) break
          }
          const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.vtt'))
          const pick = files.find((f) => f.includes(`.${lang}.`)) || files.find((f) => f.includes(`.${lang}`)) || files[0]
          if (!pick) return { videoId, transcript: null, note: 'no captions available' }
          const text = vttToText(await fs.readFile(path.join(dir, pick), 'utf8'))
          return { videoId, lang: pick.split('.').slice(-2, -1)[0], chars: text.length, transcript: text.slice(0, 60000) }
        } finally { await fs.rm(dir, { recursive: true, force: true }) }
      },
    },
  ],
}
