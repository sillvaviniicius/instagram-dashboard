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

let cache = { data: null, fetchedAt: 0 };

const BASE_URL = 'https://connectors.windsor.ai/instagram';

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

async function buildMetrics() {
  // 1. Info do perfil
  const profileRows = await fetchWindsor([
    'account_name', 'username', 'followers_count', 'follows_count', 'media_count', 'biography',
  ]);
  const profile = profileRows[0] || {};

  // 2. Série diária (últimos 30 dias)
  const dailyRows = await fetchWindsor(
    [
      'date', 'reach_1d', 'total_interactions', 'likes', 'comments', 'saves',
      'shares', 'views', 'accounts_engaged', 'follower_count_1d', 'profile_links_taps',
    ],
    { date_preset: 'last_30d' }
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

  // 3. Todos os posts do período (usado para top posts, tipo de mídia e melhor horário)
  const mediaRows = await fetchWindsor(
    [
      'media_id', 'media_caption', 'media_type', 'media_permalink', 'timestamp',
      'media_like_count', 'media_comments_count', 'media_reach', 'media_views',
      'media_saved', 'media_shares', 'media_engagement',
    ],
    { date_preset: 'last_30d', date_filters: JSON.stringify({ media_info: 'timestamp' }) }
  );

  const allPosts = mediaRows.map(r => {
    const reach = Number(r.media_reach) || 0;
    const engagement = Number(r.media_engagement) || 0;
    return {
      id: r.media_id,
      caption: (r.media_caption || '').split('\n')[0].slice(0, 90) || '(sem legenda)',
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

  // 7. Stories dos últimos 30 dias
  const storyRows = await safeFetch(
    ['story_id', 'story_views', 'story_reach', 'story_replies', 'story_exits', 'story_interactions', 'story_timestamp'],
    { date_preset: 'last_30d', date_filters: JSON.stringify({ story_info: 'story_timestamp' }) },
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
  };
  const avgEngagementRate = daily.length
    ? (daily.reduce((acc, d) => acc + (d.reach ? (d.total / d.reach) * 100 : 0), 0) / daily.length)
    : 0;

  return {
    profile: {
      name: profile.account_name || profile.username || '',
      username: profile.username || '',
      followers: Number(profile.followers_count) || 0,
      following: Number(profile.follows_count) || 0,
      posts: Number(profile.media_count) || 0,
      bio: profile.biography || '',
    },
    daily,
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

app.get('/api/metrics', async (req, res) => {
  try {
    const now = Date.now();
    const forceRefresh = req.query.refresh === '1';
    if (!cache.data || forceRefresh || now - cache.fetchedAt > CACHE_TTL_MS) {
      cache.data = await buildMetrics();
      cache.fetchedAt = now;
    }
    res.json(cache.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Falha ao buscar dados do Windsor.ai', details: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
