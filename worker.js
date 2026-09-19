// worker.js — API для EndlessBet Mini App
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    // ============ ПРОМОКОДЫ ============
    // GET /api/promos — список всех промокодов
    if (url.pathname === '/api/promos' && request.method === 'GET') {
      const list = await env.ENDLESSBET_KV.get('promos', 'json') || {};
      return Response.json(list, { headers: cors });
    }

    // POST /api/promos — создать промокод (нужен admin_token)
    if (url.pathname === '/api/promos' && request.method === 'POST') {
      const body = await request.json();
      const { admin_token, code, stars, uses } = body;

      if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
        return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
      }
      if (!code || !stars || !uses) {
        return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });
      }

      const list = await env.ENDLESSBET_KV.get('promos', 'json') || {};
      list[code.toUpperCase()] = { stars, uses, used_by: [] };
      await env.ENDLESSBET_KV.put('promos', JSON.stringify(list));

      return Response.json({ ok: true }, { headers: cors });
    }

    // POST /api/promo/activate — активировать промокод
    if (url.pathname === '/api/promo/activate' && request.method === 'POST') {
      const body = await request.json();
      const { user_id, code } = body;
      if (!user_id || !code) {
        return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });
      }
      const upCode = code.toUpperCase();

      const list = await env.ENDLESSBET_KV.get('promos', 'json') || {};
      const promo = list[upCode];

      if (!promo) return Response.json({ error: 'Промокод не найден' }, { status: 400, headers: cors });
      if (promo.uses <= 0) return Response.json({ error: 'Промокод исчерпан' }, { status: 400, headers: cors });
      if (promo.used_by.includes(user_id)) {
        return Response.json({ error: 'Вы уже использовали этот промокод' }, { status: 400, headers: cors });
      }

      promo.uses -= 1;
      promo.used_by.push(user_id);
      await env.ENDLESSBET_KV.put('promos', JSON.stringify(list));

      // Начисляем баланс
      const balances = await env.ENDLESSBET_KV.get('balances', 'json') || {};
      balances[user_id] = (balances[user_id] || 0) + promo.stars;
      await env.ENDLESSBET_KV.put('balances', JSON.stringify(balances));

      return Response.json({
        ok: true, stars: promo.stars, balance: balances[user_id]
      }, { headers: cors });
    }

    // ============ БАЛАНС ============
    // POST /api/balance — получить баланс
    if (url.pathname === '/api/balance' && request.method === 'POST') {
      const body = await request.json();
      const { user_id } = body;
      if (!user_id) return Response.json({ error: 'Нет user_id' }, { status: 400, headers: cors });

      const balances = await env.ENDLESSBET_KV.get('balances', 'json') || {};
      return Response.json({ balance: balances[user_id] || 0 }, { headers: cors });
    }

    // POST /api/balance/set — установить баланс (нужен admin_token)
    if (url.pathname === '/api/balance/set' && request.method === 'POST') {
      const body = await request.json();
      const { admin_token, user_id, balance } = body;

      if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
        return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
      }

      const balances = await env.ENDLESSBET_KV.get('balances', 'json') || {};
      balances[user_id] = balance;
      await env.ENDLESSBET_KV.put('balances', JSON.stringify(balances));

      return Response.json({ ok: true, balance }, { headers: cors });
    }

    // POST /api/balance/add — прибавить к балансу
    if (url.pathname === '/api/balance/add' && request.method === 'POST') {
      const body = await request.json();
      const { user_id, amount } = body;
      if (!user_id || typeof amount !== 'number') {
        return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });
      }

      const balances = await env.ENDLESSBET_KV.get('balances', 'json') || {};
      balances[user_id] = (balances[user_id] || 0) + amount;
      await env.ENDLESSBET_KV.put('balances', JSON.stringify(balances));

      return Response.json({ ok: true, balance: balances[user_id] }, { headers: cors });
    }

    // health check
    if (url.pathname === '/api/health') {
      return Response.json({ status: 'ok' }, { headers: cors });
    }

    return Response.json({ error: 'Not found' }, { status: 404, headers: cors });
  }
};
