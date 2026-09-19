// worker.js — API для EndlessBet Mini App (Cloudflare Workers + D1)
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

    try {

      // ============ HEALTH ============
      if (url.pathname === '/api/health') {
        return Response.json({ status: 'ok' }, { headers: cors });
      }

      // ============ БАЛАНС ============
      // POST /api/balance { user_id }
      if (url.pathname === '/api/balance' && request.method === 'POST') {
        const { user_id } = await request.json();
        if (!user_id) return Response.json({ error: 'Нет user_id' }, { status: 400, headers: cors });

        let user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        if (!user) {
          await env.DB.prepare(
            'INSERT INTO users (user_id, balance, withdrawable) VALUES (?, 0, 0)'
          ).bind(user_id).run();
          user = { balance: 0, withdrawable: 0 };
        }

        return Response.json(user, { headers: cors });
      }

      // POST /api/balance/change { user_id, amount }
      // amount > 0 — пополнение к обычному балансу
      // amount < 0 — списание (сначала withdrawable, потом balance)
      if (url.pathname === '/api/balance/change' && request.method === 'POST') {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== 'number') {
          return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });
        }

        let user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        if (!user) {
          await env.DB.prepare(
            'INSERT INTO users (user_id, balance, withdrawable) VALUES (?, 0, 0)'
          ).bind(user_id).run();
          user = { balance: 0, withdrawable: 0 };
        }

        let { balance, withdrawable } = user;

        if (amount > 0) {
          balance += amount;
        } else {
          let left = -amount;
          if (balance < left) {
            return Response.json({ error: 'Недостаточно звёзд' }, { status: 400, headers: cors });
          }
          if (withdrawable > 0) {
            const fromWd = Math.min(withdrawable, left);
            withdrawable -= fromWd;
            left -= fromWd;
          }
          balance -= left;
        }

        await env.DB.prepare(
          'UPDATE users SET balance = ?, withdrawable = ? WHERE user_id = ?'
        ).bind(balance, withdrawable, user_id).run();

        return Response.json({ balance, withdrawable }, { headers: cors });
      }

      // POST /api/balance/win { user_id, amount }
      // Начисление выигрыша: +X к balance И +X к withdrawable
      if (url.pathname === '/api/balance/win' && request.method === 'POST') {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== 'number' || amount <= 0) {
          return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });
        }

        await env.DB.prepare(`
          INSERT INTO users (user_id, balance, withdrawable) VALUES (?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            balance = balance + excluded.balance,
            withdrawable = withdrawable + excluded.withdrawable
        `).bind(user_id, amount, amount).run();

        const user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        return Response.json(user, { headers: cors });
      }

      // POST /api/balance/deposit { user_id, amount }
      // Пополнение: только к balance (не к выводу)
      if (url.pathname === '/api/balance/deposit' && request.method === 'POST') {
        const { user_id, amount } = await request.json();
        if (!user_id || typeof amount !== 'number' || amount <= 0) {
          return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });
        }

        await env.DB.prepare(`
          INSERT INTO users (user_id, balance, withdrawable) VALUES (?, ?, 0)
          ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
        `).bind(user_id, amount).run();

        const user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        return Response.json(user, { headers: cors });
      }

      // ============ ПРОМОКОДЫ ============
      // POST /api/promo/activate { user_id, code }
      if (url.pathname === '/api/promo/activate' && request.method === 'POST') {
        const { user_id, code } = await request.json();
        if (!user_id || !code) {
          return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });
        }
        const upCode = code.toUpperCase();

        const promo = await env.DB.prepare(
          'SELECT stars, uses FROM promos WHERE code = ?'
        ).bind(upCode).first();

        if (!promo) return Response.json({ error: 'Промокод не найден' }, { status: 400, headers: cors });
        if (promo.uses <= 0) return Response.json({ error: 'Промокод исчерпан' }, { status: 400, headers: cors });

        const used = await env.DB.prepare(
          'SELECT 1 FROM used_promos WHERE user_id = ? AND code = ?'
        ).bind(user_id, upCode).first();
        if (used) return Response.json({ error: 'Вы уже использовали этот промокод' }, { status: 400, headers: cors });

        // Атомарно: списать использование, пометить у юзера, начислить баланс
        await env.DB.batch([
          env.DB.prepare('UPDATE promos SET uses = uses - 1 WHERE code = ?').bind(upCode),
          env.DB.prepare('INSERT INTO used_promos (user_id, code) VALUES (?, ?)').bind(user_id, upCode),
          env.DB.prepare(`
            INSERT INTO users (user_id, balance, withdrawable) VALUES (?, ?, 0)
            ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance
          `).bind(user_id, promo.stars),
        ]);

        const user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        return Response.json({
          ok: true,
          stars: promo.stars,
          balance: user.balance,
          withdrawable: user.withdrawable
        }, { headers: cors });
      }

      // GET /api/promos — список промокодов (для админа)
      if (url.pathname === '/api/promos' && request.method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT code, stars, max_uses, uses FROM promos ORDER BY code'
        ).all();
        return Response.json(rows.results, { headers: cors });
      }

      // POST /api/promos — создать промокод { admin_token, code, stars, uses }
      if (url.pathname === '/api/promos' && request.method === 'POST') {
        const { admin_token, code, stars, uses } = await request.json();

        if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
          return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
        }
        if (!code || !stars || !uses) {
          return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });
        }

        await env.DB.prepare(
          'INSERT OR REPLACE INTO promos (code, stars, max_uses, uses) VALUES (?, ?, ?, ?)'
        ).bind(code.toUpperCase(), stars, uses, uses).run();

        return Response.json({ ok: true }, { headers: cors });
      }

      // POST /api/promos/delete — удалить промокод { admin_token, code }
      if (url.pathname === '/api/promos/delete' && request.method === 'POST') {
        const { admin_token, code } = await request.json();
        if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
          return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
        }
        await env.DB.prepare('DELETE FROM promos WHERE code = ?').bind(code.toUpperCase()).run();
        return Response.json({ ok: true }, { headers: cors });
      }

      // ============ ВЫВОДЫ ============
      // POST /api/withdraw { user_id, amount }
      if (url.pathname === '/api/withdraw' && request.method === 'POST') {
        const { user_id, amount } = await request.json();
        if (!user_id || !amount || amount < 100) {
          return Response.json({ error: 'Минимум 100 ★' }, { status: 400, headers: cors });
        }

        const user = await env.DB.prepare(
          'SELECT withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        if (!user || user.withdrawable < amount) {
          return Response.json({ error: 'Недостаточно доступных для вывода' }, { status: 400, headers: cors });
        }

        // Списываем с балансов и пишем заявку
        await env.DB.batch([
          env.DB.prepare(
            'UPDATE users SET balance = balance - ?, withdrawable = withdrawable - ? WHERE user_id = ?'
          ).bind(amount, amount, user_id),
          env.DB.prepare(
            'INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, "pending")'
          ).bind(user_id, amount),
        ]);

        return Response.json({ ok: true }, { headers: cors });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: cors });

    } catch (e) {
      return Response.json({ error: e.message || 'Internal error' }, { status: 500, headers: cors });
    }
  }
};
