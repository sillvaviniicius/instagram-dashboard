require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const WINDSOR_API_KEY = process.env.WINDSOR_API_KEY;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora

if (!WINDSOR_API_KEY) {
  console.error('ERRO: defina WINDSOR_API_KEY nas variáveis de ambiente (.env ou no painel do host).');
}

// Proteção por senha (opcional). Se DASHBOARD_PASSWORD não estiver definida,
// o dashboard fica público sem pedir login.
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;

function checkAuth(req, res, next) {
  if (!DASHBOARD_PASSWORD) return next();

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Basic ')) {
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const pass = separatorIndex === -1 ? decoded : decoded.slice(separatorIndex + 1);
    if (pass === DASHBOARD_PASSWORD) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Dashboard Instagram", charset="UTF-8"');
  res.status(401).send('Acesso restrito. Informe a senha para continuar.');
}

app.use(checkAuth);

// cache é feito por período (ver cacheStore mais abaixo)

const BASE_URL = 'https://connectors.windsor.ai/instagram';
const ADS_BASE_URL = 'https://connectors.windsor.ai/facebook';

async function fetchWindsor(fields, extraParams = {}) {
  const params = new URLSearchParams({
    api_key: WINDSOR_API_KEY,
    fields: fields.join(','),
    ...extraParams,
  });
  const url = `${BASE_URL}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Windsor.ai respondeu ${res.status}: ${text}`);
  }
  const json = await res.json();
  // Windsor.ai returns { data: [...] } for most connector endpoints
  return json.data || json;
}

async function fetchWindsorAds(fields, extraParams = {}) {
  const params = new URLSearchParams({
    api_key: WINDSOR_API_KEY,
    fields: fields.join(','),
    ...extraParams,
  });
  const url = `${ADS_BASE_URL}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Windsor.ai (facebook) respondeu ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.data || json;
}

const WEEKDAYS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

// Busca algo e devolve [] em caso de erro, sem derrubar o dashboard inteiro
async function safeFetch(fields, extraParams, label) {
  try {
    return await fetchWindsor(fields, extraParams);
  } catch (err) {
    console.error(`[aviso] falha ao buscar "${label}":`, err.message);
    return [];
  }
}

async function safeFetchAds(fields, extraParams, label) {
  try {
    return await fetchWindsorAds(fields, extraParams);
  } catch (err) {
    console.error(`[aviso] falha ao buscar "${label}":`, err.message);
    return [];
  }
}

async function buildMetrics(dateFrom, dateTo) {
  const rangeParams = dateFrom && dateTo
    ? { date_from: dateFrom, date_to: dateTo }
    : { date_preset: 'last_30d' };

  // 1. Info do perfil
  const profileRows = await fetchWindsor([
    'account_name', 'username', 'followers_count', 'follows_count', 'media_count', 'biography',
  ]);
  const profile = profileRows[0] || {};

  // 2. Série diária (período selecionado)
  const dailyRows = await fetchWindsor(
    [
      'date', 'reach_1d', 'total_interactions', 'likes', 'comments', 'saves',
      'shares', 'views', 'accounts_engaged', 'follower_count_1d', 'profile_links_taps',
    ],
    rangeParams
  );
  const daily = dailyRows
    .map(r => ({
      date: r.date,
      reach: Number(r.reach_1d) || 0,
      views: Number(r.views) || 0,
      total: Number(r.total_interactions) || 0,
      likes: Number(r.likes) || 0,
      comments: Number(r.comments) || 0,
      saves: Number(r.saves) || 0,
      shares: Number(r.shares) || 0,
      followers: Number(r.follower_count_1d) || 0,
      profileLinkTaps: Number(r.profile_links_taps) || 0,
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // 3. Todos os posts do período (usado para top posts, tipo de mídia, timeline e melhor horário)
  const mediaRows = await fetchWindsor(
    [
      'media_id', 'media_caption', 'media_type', 'media_permalink', 'timestamp',
      'media_like_count', 'media_comments_count', 'media_reach', 'media_views',
      'media_saved', 'media_shares', 'media_engagement', 'media_url', 'media_thumbnail_url',
    ],
    { ...rangeParams, date_filters: JSON.stringify({ media_info: 'timestamp' }) }
  );

  const allPosts = mediaRows.map(r => {
    const reach = Number(r.media_reach) || 0;
    const engagement = Number(r.media_engagement) || 0;
    const isVideoLike = r.media_type === 'REELS' || r.media_type === 'VIDEO';
    return {
      id: r.media_id,
      caption: (r.media_caption || '').trim() || '(sem legenda)',
      type: r.media_type,
      url: r.media_permalink,
      date: r.timestamp,
      likes: Number(r.media_like_count) || 0,
      comments: Number(r.media_comments_count) || 0,
      reach,
      views: Number(r.media_views) || 0,
      saves: Number(r.media_saved) || 0,
      shares: Number(r.media_shares) || 0,
      engagement,
      engagementRate: reach ? (engagement / reach) * 100 : 0,
      thumbnail: (isVideoLike ? r.media_thumbnail_url : r.media_url) || r.media_thumbnail_url || r.media_url || null,
    };
  });

  const topPosts = [...allPosts].sort((a, b) => b.engagement - a.engagement).slice(0, 5);
  const topByRate = [...allPosts].filter(p => p.reach >= 300).sort((a, b) => b.engagementRate - a.engagementRate).slice(0, 5);

  // 4. Comparação por tipo de mídia
  const typeGroups = {};
  allPosts.forEach(p => {
    const t = p.type || 'OUTRO';
    if (!typeGroups[t]) typeGroups[t] = { type: t, count: 0, reach: 0, views: 0, engagement: 0, engagementRateSum: 0 };
    const g = typeGroups[t];
    g.count += 1;
    g.reach += p.reach;
    g.views += p.views;
    g.engagement += p.engagement;
    g.engagementRateSum += p.engagementRate;
  });
  const mediaTypeBreakdown = Object.values(typeGroups).map(g => ({
    type: g.type,
    count: g.count,
    avgReach: g.count ? g.reach / g.count : 0,
    avgViews: g.count ? g.views / g.count : 0,
    avgEngagementRate: g.count ? g.engagementRateSum / g.count : 0,
  })).sort((a, b) => b.count - a.count);

  // 5. Melhor dia/horário para postar (baseado no alcance médio dos posts)
  const slotGroups = {}; // "diaSemana-horaBucket" -> {reachSum, count}
  const hourBucket = h => {
    if (h < 6) return 'Madrugada (0h–6h)';
    if (h < 12) return 'Manhã (6h–12h)';
    if (h < 18) return 'Tarde (12h–18h)';
    return 'Noite (18h–24h)';
  };
  allPosts.forEach(p => {
    const d = new Date(p.date);
    if (isNaN(d)) return;
    const key = `${WEEKDAYS_PT[d.getUTCDay()]}|${hourBucket(d.getUTCHours())}`;
    if (!slotGroups[key]) slotGroups[key] = { reachSum: 0, count: 0 };
    slotGroups[key].reachSum += p.reach;
    slotGroups[key].count += 1;
  });
  const bestTimes = Object.entries(slotGroups)
    .map(([key, g]) => {
      const [day, slot] = key.split('|');
      return { day, slot, avgReach: g.reachSum / g.count, count: g.count };
    })
    .filter(s => s.count >= 1)
    .sort((a, b) => b.avgReach - a.avgReach)
    .slice(0, 5);

  // 6. Demografia do público (idade, gênero, país) — dados lifetime, buscados à parte
  const [ageRows, genderRows, countryRows] = await Promise.all([
    safeFetch(['audience_age_name', 'audience_age_size'], {}, 'demografia (idade)'),
    safeFetch(['audience_gender_name', 'audience_gender_size'], {}, 'demografia (gênero)'),
    safeFetch(['audience_country_name', 'audience_country_size'], {}, 'demografia (país)'),
  ]);
  const audience = {
    age: ageRows
      .map(r => ({ name: r.audience_age_name, value: Number(r.audience_age_size) || 0 }))
      .filter(r => r.name)
      .sort((a, b) => a.name.localeCompare(b.name)),
    gender: genderRows
      .map(r => ({ name: r.audience_gender_name, value: Number(r.audience_gender_size) || 0 }))
      .filter(r => r.name),
    country: countryRows
      .map(r => ({ name: r.audience_country_name, value: Number(r.audience_country_size) || 0 }))
      .filter(r => r.name)
      .sort((a, b) => b.value - a.value)
      .slice(0, 6),
  };

  // 7. Stories do período selecionado
  const storyRows = await safeFetch(
    ['story_id', 'story_views', 'story_reach', 'story_replies', 'story_exits', 'story_interactions', 'story_timestamp'],
    { ...rangeParams, date_filters: JSON.stringify({ story_info: 'story_timestamp' }) },
    'stories'
  );
  const stories = {
    count: storyRows.length,
    totalViews: storyRows.reduce((a, r) => a + (Number(r.story_views) || 0), 0),
    totalReach: storyRows.reduce((a, r) => a + (Number(r.story_reach) || 0), 0),
    totalReplies: storyRows.reduce((a, r) => a + (Number(r.story_replies) || 0), 0),
    totalExits: storyRows.reduce((a, r) => a + (Number(r.story_exits) || 0), 0),
    totalInteractions: storyRows.reduce((a, r) => a + (Number(r.story_interactions) || 0), 0),
  };

  // 8. Totais e médias gerais
  const sum = key => daily.reduce((acc, d) => acc + d[key], 0);
  const totals = {
    reach: sum('reach'),
    views: sum('views'),
    interactions: sum('total'),
    newFollowers: sum('followers'),
    profileLinkTaps: sum('profileLinkTaps'),
    likes: sum('likes'),
    comments: sum('comments'),
    saves: sum('saves'),
    shares: sum('shares'),
  };
  const avgEngagementRate = daily.length
    ? (daily.reduce((acc, d) => acc + (d.reach ? (d.total / d.reach) * 100 : 0), 0) / daily.length)
    : 0;

  // 9. Comparação com o período anterior (mesmo número de dias, imediatamente antes)
  function addDaysStr(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  const periodFrom = dateFrom || (daily[0] && daily[0].date);
  const periodTo = dateTo || (daily[daily.length - 1] && daily[daily.length - 1].date);
  let comparison = null;
  if (periodFrom && periodTo) {
    const lengthDays = Math.round(
      (new Date(periodTo + 'T00:00:00Z') - new Date(periodFrom + 'T00:00:00Z')) / 86400000
    ) + 1;
    const prevTo = addDaysStr(periodFrom, -1);
    const prevFrom = addDaysStr(prevTo, -(lengthDays - 1));

    const prevRows = await safeFetch(
      ['date', 'reach_1d', 'total_interactions', 'follower_count_1d'],
      { date_from: prevFrom, date_to: prevTo },
      'período anterior'
    );
    const prevDaily = prevRows.map(r => ({
      reach: Number(r.reach_1d) || 0,
      total: Number(r.total_interactions) || 0,
      followers: Number(r.follower_count_1d) || 0,
    }));
    const prevSum = key => prevDaily.reduce((a, d) => a + d[key], 0);
    const prevTotals = {
      reach: prevSum('reach'),
      interactions: prevSum('total'),
      newFollowers: prevSum('followers'),
    };
    const prevAvgEngagementRate = prevDaily.length
      ? prevDaily.reduce((acc, d) => acc + (d.reach ? (d.total / d.reach) * 100 : 0), 0) / prevDaily.length
      : 0;

    // null = sem dado suficiente pra comparar (evita divisão por zero / número infinito)
    const pct = (curr, prev) => {
      if (!prevDaily.length) return null;
      if (prev === 0) return curr === 0 ? 0 : null;
      return ((curr - prev) / prev) * 100;
    };

    comparison = {
      previousPeriod: { from: prevFrom, to: prevTo },
      reachPct: pct(totals.reach, prevTotals.reach),
      interactionsPct: pct(totals.interactions, prevTotals.interactions),
      newFollowersPct: pct(totals.newFollowers, prevTotals.newFollowers),
      engagementRatePct: pct(avgEngagementRate, prevAvgEngagementRate),
    };
  }

  // 11. Tráfego pago (Meta Ads — Facebook/Instagram Ads) do período selecionado
  const adsRows = await safeFetchAds(
    [
      'account_name', 'account_currency', 'campaign', 'campaign_status', 'objective',
      'spend', 'impressions', 'clicks', 'reach', 'actions_lead',
    ],
    rangeParams,
    'tráfego pago (Meta Ads)'
  );
  const adsCurrency = (adsRows[0] && adsRows[0].account_currency) || 'BRL';
  const campaigns = adsRows
    .map(r => {
      const spend = Number(r.spend) || 0;
      const impressions = Number(r.impressions) || 0;
      const clicks = Number(r.clicks) || 0;
      return {
        account: r.account_name || '',
        campaign: r.campaign || '(sem nome)',
        status: r.campaign_status || '',
        objective: r.objective || '',
        spend,
        impressions,
        clicks,
        ctr: impressions ? (clicks / impressions) * 100 : 0,
        cpc: clicks ? spend / clicks : 0,
        reach: Number(r.reach) || 0,
        leads: r.actions_lead != null ? Number(r.actions_lead) : null,
      };
    })
    .filter(c => c.spend > 0 || c.impressions > 0)
    .sort((a, b) => b.spend - a.spend);

  const adsTotalsRaw = {
    spend: campaigns.reduce((a, c) => a + c.spend, 0),
    impressions: campaigns.reduce((a, c) => a + c.impressions, 0),
    clicks: campaigns.reduce((a, c) => a + c.clicks, 0),
    reach: campaigns.reduce((a, c) => a + c.reach, 0),
    leads: campaigns.reduce((a, c) => a + (c.leads || 0), 0),
  };
  const ads = {
    currency: adsCurrency,
    campaigns,
    totals: {
      ...adsTotalsRaw,
      avgCtr: adsTotalsRaw.impressions ? (adsTotalsRaw.clicks / adsTotalsRaw.impressions) * 100 : 0,
      avgCpc: adsTotalsRaw.clicks ? adsTotalsRaw.spend / adsTotalsRaw.clicks : 0,
      costPerLead: adsTotalsRaw.leads ? adsTotalsRaw.spend / adsTotalsRaw.leads : null,
    },
  };

  // 12. Timeline cronológica de posts (com miniatura)
  const timeline = [...allPosts].sort((a, b) => new Date(a.date) - new Date(b.date));

  return {
    profile: {
      name: profile.account_name || profile.username || '',
      username: profile.username || '',
      followers: Number(profile.followers_count) || 0,
      following: Number(profile.follows_count) || 0,
      posts: Number(profile.media_count) || 0,
      bio: profile.biography || '',
    },
    period: {
      from: periodFrom || null,
      to: periodTo || null,
    },
    comparison,
    daily,
    timeline,
    ads,
    topPosts,
    topByRate,
    mediaTypeBreakdown,
    bestTimes,
    audience,
    stories,
    totals,
    avgEngagementRate,
    generatedAt: new Date().toISOString(),
  };
}

const cacheStore = new Map(); // chave "from|to" -> { data, fetchedAt }

function isValidDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));
}

app.get('/api/metrics', async (req, res) => {
  try {
    let { date_from, date_to, refresh } = req.query;
    if (date_from && !isValidDate(date_from)) date_from = undefined;
    if (date_to && !isValidDate(date_to)) date_to = undefined;
    // se só uma das datas veio, ignora as duas e cai no padrão de 30 dias
    if ((date_from && !date_to) || (!date_from && date_to)) {
      date_from = undefined;
      date_to = undefined;
    }

    const cacheKey = `${date_from || ''}|${date_to || ''}`;
    const now = Date.now();
    const forceRefresh = refresh === '1';
    const entry = cacheStore.get(cacheKey);

    if (!entry || forceRefresh || now - entry.fetchedAt > CACHE_TTL_MS) {
      const data = await buildMetrics(date_from, date_to);
      cacheStore.set(cacheKey, { data, fetchedAt: now });
      return res.json(data);
    }
    res.json(entry.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao buscar dados do Windsor.ai', details: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
