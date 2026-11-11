/* Vercel Serverless Function : GET /api/matches
   La clé API reste ICI, côté serveur : Vercel > Settings > Environment Variables > API_FOOTBALL_KEY
   (optionnel) API_FOOTBALL_SEASON : forcer la saison, ex. 2024 si votre plan gratuit est limité. */

const BASE = "https://v3.football.api-sports.io";
const LEAGUES = { 39: "Premier League", 140: "La Liga", 61: "Ligue 1", 135: "Serie A", 78: "Bundesliga" };
const BOOKMAKER = 8; // 8 = Bet365 (modifiable)

async function api(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "x-apisports-key": process.env.API_FOOTBALL_KEY } });
  if (!r.ok) throw new Error("API-Football HTTP " + r.status);
  const j = await r.json();
  const errs = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (errs.length) throw new Error(errs.join(" | "));
  return j;
}

/* Force offensive/défensive de chaque équipe à partir des buts marqués/encaissés */
function strengths(table) {
  const played = table.reduce((s, t) => s + t.all.played, 0);
  if (!played) return null;
  const avg = table.reduce((s, t) => s + t.all.goals.for, 0) / played;
  const hp = table.reduce((s, t) => s + t.home.played, 0), ap = table.reduce((s, t) => s + t.away.played, 0);
  const avgH = table.reduce((s, t) => s + t.home.goals.for, 0) / (hp || 1);
  const avgA = table.reduce((s, t) => s + t.away.goals.for, 0) / (ap || 1);
  const adv = Math.min(1.3, Math.max(1, Math.sqrt(avgH / (avgA || 1)))); // avantage du terrain
  const teams = {};
  for (const t of table) {
    if (t.all.played < 3) continue; // échantillon trop faible
    teams[t.team.id] = { att: t.all.goals.for / t.all.played / avg, def: t.all.goals.against / t.all.played / avg };
  }
  return { avg, adv, teams };
}

async function oddsFor(league, season, date) {
  const map = {};
  for (let page = 1; page <= 2; page++) {
    const j = await api("/odds", { league, season, date, bookmaker: BOOKMAKER, page });
    for (const o of j.response) {
      const bets = o.bookmakers?.[0]?.bets || [];
      const win = bets.find(b => b.id === 1), ou = bets.find(b => b.id === 5);
      const val = (bet, v) => { const x = bet?.values.find(y => y.value === v); return x ? parseFloat(x.odd) : undefined; };
      map[o.fixture.id] = { h: val(win, "Home"), d: val(win, "Draw"), a: val(win, "Away"), o25: val(ou, "Over 2.5") };
    }
    if (page >= (j.paging?.total || 1)) break;
  }
  return map;
}

const clean = s => String(s).replace(/[<>&"']/g, "");
const round = x => Math.round(x * 100) / 100;

module.exports = async (req, res) => {
  if (!process.env.API_FOOTBALL_KEY) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(500).json({ error: "Variable d’environnement API_FOOTBALL_KEY manquante" });
  }
  try {
    const now = new Date();
    const season = process.env.API_FOOTBALL_SEASON || (now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

    // Premier jour (aujourd’hui, demain, après-demain) avec des matchs à venir
    let fixtures = [], date;
    for (let i = 0; i < 3 && !fixtures.length; i++) {
      date = new Date(now.getTime() + i * 864e5).toISOString().slice(0, 10);
      const j = await api("/fixtures", { date });
      fixtures = j.response.filter(f => LEAGUES[f.league.id] && f.fixture.status.short === "NS");
    }

    // Classement + cotes, une fois par championnat concerné
    const ids = [...new Set(fixtures.map(f => f.league.id))];
    const errors = [];
    const perLeague = {};
    await Promise.all(ids.map(async id => {
      const [st, od] = await Promise.allSettled([api("/standings", { league: id, season }), oddsFor(id, season, date)]);
      if (st.status === "rejected") errors.push(st.reason.message);
      perLeague[id] = {
        S: st.status === "fulfilled" ? strengths(st.value.response[0]?.league?.standings?.[0] || []) : null,
        odds: od.status === "fulfilled" ? od.value : {}
      };
    }));

    const matches = [];
    for (const f of fixtures) {
      const L = perLeague[f.league.id], S = L?.S;
      const h = S?.teams[f.teams.home.id], a = S?.teams[f.teams.away.id];
      if (!h || !a) continue;
      const o = L.odds[f.fixture.id] || {};
      matches.push({
        id: f.fixture.id,
        league: LEAGUES[f.league.id],
        kickoff: f.fixture.date,
        home: clean(f.teams.home.name),
        away: clean(f.teams.away.name),
        xgH: round(S.avg * S.adv * h.att * a.def),
        xgA: round((S.avg / S.adv) * a.att * h.def),
        odds: { h: o.h, d: o.d, a: o.a },
        over25: o.o25
      });
    }
    if (!matches.length && errors.length) throw new Error(errors[0]);

    matches.sort((x, y) => new Date(x.kickoff) - new Date(y.kickoff));
    // 4 h de cache côté Vercel : ~10 appels API par rafraîchissement, bien sous les 100/jour du plan gratuit
    res.setHeader("Cache-Control", "s-maxage=14400, stale-while-revalidate=3600");
    return res.status(200).json({ date, season, matches: matches.slice(0, 12) });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: e.message });
  }
};
