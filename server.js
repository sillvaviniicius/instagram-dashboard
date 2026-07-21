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
      'shares', 'views', 'accounts_engaged', 'follower_count_1d',
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
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  // 3. Posts individuais (últimos 30 dias) para o ranking de melhores posts
  const mediaRows = await fetchWindsor(
    [
      'media_id', 'media_caption', 'media_type', 'media_permalink', 'timestamp',
      'media_like_count', 'media_comments_count', 'media_reach', 'media_views',
      'media_saved', 'media_shares', 'media_engagement',
    ],
    { date_preset: 'last_30d', date_filters: JSON.stringify({ media_info: 'timestamp' }) }
  );

  const topPosts = mediaRows
    .map(r => ({
      id: r.media_id,
      caption: (r.media_caption || '').split('\n')[0].slice(0, 90) || '(sem legenda)',
      type: r.media_type,
      url: r.media_permalink,
      date: r.timestamp,
      likes: Number(r.media_like_count) || 0,
      comments: Number(r.media_comments_count) || 0,
      reach: Number(r.media_reach) || 0,
      views: Number(r.media_views) || 0,
      saves: Number(r.media_saved) || 0,
      shares: Number(r.media_shares) || 0,
      engagement: Number(r.media_engagement) || 0,
    }))
    .sort((a, b) => b.engagement - a.engagement)
    .slice(0, 5);

  // 4. Totais e médias
  const sum = key => daily.reduce((acc, d) => acc + d[key], 0);
  const totals = {
    reach: sum('reach'),
    views: sum('views'),
    interactions: sum('total'),
    newFollowers: sum('followers'),
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
