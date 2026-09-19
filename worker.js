// worker.js — API для EndlessBet
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {

      if (url.pathname === '/api/health') {
        return Response.json({ status: 'ok' }, { headers: cors });
      }

      // ============ БАЛАНС ============
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
      if (url.pathname === '/api/promo/activate' && request.method === 'POST') {
        const { user_id, code } = await request.json();
        if (!user_id || !code) return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });
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
          ok: true, stars: promo.stars,
          balance: user.balance, withdrawable: user.withdrawable
        }, { headers: cors });
      }

      if (url.pathname === '/api/promos' && request.method === 'POST') {
        const { admin_token, code, stars, uses } = await request.json();
        if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
          return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
        }
        if (!code || !stars || !uses) return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });

        await env.DB.prepare(
          'INSERT OR REPLACE INTO promos (code, stars, max_uses, uses) VALUES (?, ?, ?, ?)'
        ).bind(code.toUpperCase(), stars, uses, uses).run();

        return Response.json({ ok: true }, { headers: cors });
      }

      // ============ ИНВЕНТАРЬ ============
      if (url.pathname === '/api/inventory' && request.method === 'GET') {
        const user_id = url.searchParams.get('user_id');
        if (!user_id) return Response.json({ error: 'Нет user_id' }, { status: 400, headers: cors });

        const rows = await env.DB.prepare(
          'SELECT case_key, count FROM inventory WHERE user_id = ? AND count > 0'
        ).bind(user_id).all();

        const inv = {};
        for (const r of (rows.results || [])) inv[r.case_key] = r.count;
        return Response.json(inv, { headers: cors });
      }

      if (url.pathname === '/api/inventory/add' && request.method === 'POST') {
        const { user_id, case_key } = await request.json();
        if (!user_id || !case_key) return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });

        await env.DB.prepare(`
          INSERT INTO inventory (user_id, case_key, count) VALUES (?, ?, 1)
          ON CONFLICT(user_id, case_key) DO UPDATE SET count = count + 1
        `).bind(user_id, case_key).run();

        const row = await env.DB.prepare(
          'SELECT count FROM inventory WHERE user_id = ? AND case_key = ?'
        ).bind(user_id, case_key).first();

        return Response.json({ ok: true, count: row ? row.count : 0 }, { headers: cors });
      }

      if (url.pathname === '/api/inventory/spend' && request.method === 'POST') {
        const { user_id, case_key } = await request.json();
        if (!user_id || !case_key) return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });

        const row = await env.DB.prepare(
          'SELECT count FROM inventory WHERE user_id = ? AND case_key = ?'
        ).bind(user_id, case_key).first();

        if (!row || row.count <= 0) {
          return Response.json({ error: 'Нет кейса' }, { status: 400, headers: cors });
        }

        await env.DB.prepare(
          'UPDATE inventory SET count = count - 1 WHERE user_id = ? AND case_key = ?'
        ).bind(user_id, case_key).run();

        return Response.json({ ok: true, count: row.count - 1 }, { headers: cors });
      }

      // ============ ПОПОЛНЕНИЕ ЗВЁЗДАМИ ============
      if (url.pathname === '/api/create-invoice' && request.method === 'POST') {
        const { user_id, package: pkg } = await request.json();
        if (!user_id || !pkg) return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });

        const PACKAGES = {
          topup_50:   { stars: 50,   price: 50 },
          topup_100:  { stars: 100,  price: 100 },
          topup_500:  { stars: 500,  price: 500 },
          topup_1000: { stars: 1000, price: 1000 },
        };

        const info = PACKAGES[pkg];
        if (!info) return Response.json({ error: 'Пакет не найден' }, { status: 400, headers: cors });

        const tgResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Пополнение на ${info.stars} ★`,
            description: `Баланс EndlessBet пополнится на ${info.stars} звёзд.`,
            payload: `topup:${pkg}:${user_id}`,
            currency: 'XTR',
            prices: [{ label: `${info.stars} звёзд`, amount: info.price }],
          }),
        });

        const data = await tgResp.json();
        if (!data.ok) {
          return Response.json({ error: data.description || 'Telegram error' }, { status: 500, headers: cors });
        }
        return Response.json({ ok: true, invoice_link: data.result }, { headers: cors });
      }

      // ============ ВЫВОДЫ ============
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

      if (url.pathname === '/api/withdrawals' && request.method === 'GET') {
        const rows = await env.DB.prepare(
          'SELECT id, user_id, amount, status, created_at FROM withdrawals WHERE status = "pending" ORDER BY created_at DESC'
        ).all();
        return Response.json(rows.results || [], { headers: cors });
      }

      if (url.pathname === '/api/withdrawals/action' && request.method === 'POST') {
        const { admin_token, id, action } = await request.json();
        if (!admin_token || admin_token !== env.ADMIN_TOKEN) {
          return Response.json({ error: 'Нет доступа' }, { status: 403, headers: cors });
        }
        if (!id || !action) return Response.json({ error: 'Не все поля' }, { status: 400, headers: cors });

        const w = await env.DB.prepare(
          'SELECT user_id, amount FROM withdrawals WHERE id = ?'
        ).bind(id).first();
        if (!w) return Response.json({ error: 'Заявка не найдена' }, { status: 404, headers: cors });

        if (action === 'approve') {
          await env.DB.prepare('UPDATE withdrawals SET status = "approved" WHERE id = ?').bind(id).run();
        } else if (action === 'reject') {
          await env.DB.batch([
            env.DB.prepare('UPDATE withdrawals SET status = "rejected" WHERE id = ?').bind(id),
            env.DB.prepare(
              'UPDATE users SET balance = balance + ?, withdrawable = withdrawable + ? WHERE user_id = ?'
            ).bind(w.amount, w.amount, w.user_id),
          ]);
        }

        return Response.json({ ok: true }, { headers: cors });
      }

      return Response.json({ error: 'Not found' }, { status: 404, headers: cors });

    } catch (e) {
      return Response.json({ error: e.message || 'Internal error' }, { status: 500, headers: cors });
    }
  }
};
