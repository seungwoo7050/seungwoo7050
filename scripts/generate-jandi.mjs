import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

const OWNER = process.env.JANDI_OWNER
const USERNAME = process.env.JANDI_USERNAME ?? OWNER
const INCLUDE_PRIVATE = process.env.JANDI_INCLUDE_PRIVATE === 'true'
const TOKEN = process.env.JANDI_TOKEN
const OUT_PATH = process.env.JANDI_OUT ?? 'assets/jandi.svg'
const DAYS_BACK = Number(process.env.JANDI_DAYS_BACK ?? 371) // ~53 weeks, GitHub-calendar length

if (!OWNER) throw new Error('JANDI_OWNER is required')
if (!TOKEN) throw new Error('JANDI_TOKEN is required')

const API = 'https://api.github.com'

async function gh(pathname, params = {}) {
  const url = new URL(API + pathname)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${pathname}`)
  return res
}

async function ghPaginated(pathname, params = {}) {
  const results = []
  for (let page = 1; ; page += 1) {
    const res = await gh(pathname, { ...params, per_page: 100, page })
    const body = await res.json()
    if (!Array.isArray(body) || body.length === 0) break
    results.push(...body)
    if (body.length < 100) break
  }
  return results
}

async function listRepos() {
  if (INCLUDE_PRIVATE) {
    return ghPaginated('/user/repos', { affiliation: 'owner', visibility: 'all' })
  }
  return ghPaginated(`/users/${OWNER}/repos`, { type: 'owner' })
}

async function listBranches(repo) {
  return ghPaginated(`/repos/${OWNER}/${repo}/branches`)
}

async function listAuthoredCommitDays(repo, branch) {
  const commits = await ghPaginated(`/repos/${OWNER}/${repo}/commits`, {
    sha: branch,
    author: USERNAME,
  })
  return commits.map((c) => ({ sha: c.sha, date: c.commit.author.date }))
}

function toUtcDateKey(iso) {
  return iso.slice(0, 10)
}

async function collect() {
  const repos = (await listRepos()).filter((r) => !r.fork)
  const seenShas = new Set()
  const counts = new Map()

  for (const repo of repos) {
    let branches
    try {
      branches = await listBranches(repo.name)
    } catch (err) {
      console.error(`skip repo ${repo.name}: ${err.message}`)
      continue
    }
    for (const branch of branches) {
      let days
      try {
        days = await listAuthoredCommitDays(repo.name, branch.name)
      } catch (err) {
        console.error(`skip ${repo.name}@${branch.name}: ${err.message}`)
        continue
      }
      for (const { sha, date } of days) {
        if (seenShas.has(sha)) continue
        seenShas.add(sha)
        const key = toUtcDateKey(date)
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    }
  }
  return counts
}

const CELL = 11
const GAP = 3
const LEVELS = [0, 1, 3, 6, 10]
const COLORS = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']

function levelFor(count) {
  let lvl = 0
  for (let i = LEVELS.length - 1; i >= 0; i -= 1) {
    if (count >= LEVELS[i]) {
      lvl = i
      break
    }
  }
  return lvl
}

function buildWeeks(counts, daysBack) {
  const end = new Date()
  end.setUTCHours(0, 0, 0, 0)
  const start = new Date(end)
  start.setUTCDate(start.getUTCDate() - daysBack)
  start.setUTCDate(start.getUTCDate() - start.getUTCDay()) // align to Sunday

  const weeks = []
  const cursor = new Date(start)
  while (cursor <= end) {
    const week = []
    for (let d = 0; d < 7; d += 1) {
      const key = cursor.toISOString().slice(0, 10)
      week.push({ date: key, count: counts.get(key) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    weeks.push(week)
  }
  return weeks
}

const MONTHS_KO = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월']
const WEEKDAY_ROWS = { 1: '월', 3: '수', 5: '금' }
const LEFT = 22
const SUMMARY_Y = 10
const MONTH_LABEL_Y = 24
const GRID_TOP = 30

function renderSvg(counts, { daysBack }) {
  const weeks = buildWeeks(counts, daysBack)
  const total = weeks.reduce((sum, week) => sum + week.reduce((s, day) => s + day.count, 0), 0)
  const width = LEFT + weeks.length * (CELL + GAP) + GAP
  const height = GRID_TOP + 7 * (CELL + GAP) + GAP

  const cells = weeks
    .map((week, wi) =>
      week
        .map((day, di) => {
          const x = LEFT + wi * (CELL + GAP)
          const y = GRID_TOP + di * (CELL + GAP)
          const color = COLORS[levelFor(day.count)]
          return `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${color}"><title>${day.date}: ${day.count} commits</title></rect>`
        })
        .join(''),
    )
    .join('')

  const monthLabels = weeks
    .map((week, wi) => {
      const month = Number(week[0].date.slice(5, 7)) - 1
      const prevMonth = wi === 0 ? -1 : Number(weeks[wi - 1][0].date.slice(5, 7)) - 1
      if (month === prevMonth) return ''
      const yy = week[0].date.slice(2, 4)
      const text = month === 0 ? `${yy}.${MONTHS_KO[month]}` : MONTHS_KO[month]
      const x = LEFT + wi * (CELL + GAP)
      return `<text x="${x}" y="${MONTH_LABEL_Y}" font-size="10" fill="#57606a">${text}</text>`
    })
    .join('')

  const weekdayLabels = Object.entries(WEEKDAY_ROWS)
    .map(([di, label]) => {
      const y = GRID_TOP + Number(di) * (CELL + GAP) + CELL - 2
      return `<text x="0" y="${y}" font-size="9" fill="#57606a">${label}</text>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
  <text x="${LEFT}" y="${SUMMARY_Y}" font-size="12" fill="#57606a">최근 1년 커밋 ${total}개</text>
  ${monthLabels}
  ${weekdayLabels}
  ${cells}
</svg>`
}

const counts = await collect()
const allTimeTotal = [...counts.values()].reduce((a, b) => a + b, 0)
const svg = renderSvg(counts, { daysBack: DAYS_BACK })

await mkdir(path.dirname(path.resolve(OUT_PATH)), { recursive: true })
await writeFile(path.resolve(OUT_PATH), svg)
console.log(`wrote ${OUT_PATH} (${allTimeTotal} commits all-time across ${counts.size} days, includePrivate=${INCLUDE_PRIVATE})`)
