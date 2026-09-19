// worker.js — API для EndlessBet
const CHANNEL = "EndlessBet_channel";
const CHANNEL_URL = "https://t.me/" + CHANNEL;

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

      // ============ HEALTH ============
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

        await env.DB.prepare(
          'INSERT OR IGNORE INTO users (user_id, balance, withdrawable) VALUES (?, 0, 0)'
        ).bind(user_id).run();

        if (amount > 0) {
          await env.DB.prepare(
            'UPDATE users SET balance = balance + ? WHERE user_id = ?'
          ).bind(amount, user_id).run();
        } else {
          const need = -amount;

          const result = await env.DB.prepare(`
            UPDATE users SET
              balance = balance - ?,
              withdrawable = CASE
                WHEN withdrawable >= ? THEN withdrawable - ?
                ELSE 0
              END
            WHERE user_id = ? AND balance >= ?
          `).bind(need, need, need, user_id, need).run();

          if (!result.meta || result.meta.changes === 0) {
            return Response.json({ error: 'Недостаточно звёзд' }, { status: 400, headers: cors });
          }
        }

        const user = await env.DB.prepare(
          'SELECT balance, withdrawable FROM users WHERE user_id = ?'
        ).bind(user_id).first();

        return Response.json(user, { headers: cors });
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

        const upd = await env.DB.prepare(
          'UPDATE promos SET uses = uses - 1 WHERE code = ? AND uses > 0'
        ).bind(upCode).run();
        if (!upd.meta || upd.meta.changes === 0) {
          return Response.json({ error: 'Промокод исчерпан' }, { status: 400, headers: cors });
        }

        await env.DB.batch([
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

        const upd = await env.DB.prepare(`
          UPDATE inventory SET count = count - 1
          WHERE user_id = ? AND case_key = ? AND count > 0
        `).bind(user_id, case_key).run();

        if (!upd.meta || upd.meta.changes === 0) {
          return Response.json({ error: 'Нет кейса' }, { status: 400, headers: cors });
        }

        const row = await env.DB.prepare(
          'SELECT count FROM inventory WHERE user_id = ? AND case_key = ?'
        ).bind(user_id, case_key).first();

        return Response.json({ ok: true, count: row ? row.count : 0 }, { headers: cors });
      }

      // ============ ПОДПИСОЧНЫЙ КЕЙС ============
      // POST /api/sub-case/status { user_id }
      if (url.pathname === '/api/sub-case/status' && request.method === 'POST') {
        const { user_id } = await request.json();
        if (!user_id) return Response.json({ error: 'Нет user_id' }, { status: 400, headers: cors });

        // Проверяем подписку через Telegram API
        let subscribed = false;
        try {
          const tgResp = await fetch(
            `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL}&user_id=${user_id}`
          );
          const data = await tgResp.json();
          if (data.ok) {
            const status = data.result.status;
            subscribed = (status === 'member' || status === 'administrator' || status === 'creator');
          }
        } catch (e) {}

        // Проверяем кулдаун
        const row = await env.DB.prepare(
          'SELECT last_opened FROM subscription_cases WHERE user_id = ?'
        ).bind(user_id).first();

        let nextAt = 0;
        if (row && row.last_opened) {
          const last = new Date(row.last_opened + 'Z').getTime();
          nextAt = last + 24 * 60 * 60 * 1000;
        }

        const now = Date.now();
        const canOpen = subscribed && now >= nextAt;

        return Response.json({
          subscribed,
          can_open: canOpen,
          next_at: nextAt
        }, { headers: cors });
      }

      // POST /api/sub-case/open { user_id }
      if (url.pathname === '/api/sub-case/open' && request.method === 'POST') {
        const { user_id } = await request.json();
        if (!user_id) return Response.json({ error: 'Нет user_id' }, { status: 400, headers: cors });

        // Ещё раз проверяем подписку (нельзя доверять фронту)
        let subscribed = false;
        try {
          const tgResp = await fetch(
            `https://api.telegram.org/bot${env.BOT_TOKEN}/getChatMember?chat_id=@${CHANNEL}&user_id=${user_id}`
          );
          const data = await tgResp.json();
          if (data.ok) {
            const status = data.result.status;
            subscribed = (status === 'member' || status === 'administrator' || status === 'creator');
          }
        } catch (e) {}

        if (!subscribed) {
          return Response.json({ error: 'Подпишись на канал' }, { status: 400, headers: cors });
        }

        // Проверяем кулдаун
        const row = await env.DB.prepare(
          'SELECT last_opened FROM subscription_cases WHERE user_id = ?'
        ).bind(user_id).first();

        if (row && row.last_opened) {
          const last = new Date(row.last_opened + 'Z').getTime();
          const nextAt = last + 24 * 60 * 60 * 1000;
          if (Date.now() < nextAt) {
            return Response.json({ error: 'Кейс уже открыт' }, { status: 400, headers: cors });
          }
        }

        // Записываем время открытия
        await env.DB.prepare(`
          INSERT INTO subscription_cases (user_id, last_opened) VALUES (?, CURRENT_TIMESTAMP)
          ON CONFLICT(user_id) DO UPDATE SET last_opened = CURRENT_TIMESTAMP
        `).bind(user_id).run();

        return Response.json({ ok: true }, { headers: cors });
      }

      // ============ ПОПОЛНЕНИЕ ЗВЁЗДАМИ ============
      if (url.pathname === '/api/create-invoice' && request.method === 'POST') {
        const { user_id, stars } = await request.json();
        if (!user_id || !stars) return Response.json({ error: 'Неверные данные' }, { status: 400, headers: cors });

        const amount = parseInt(stars, 10);
        if (!amount || amount < 1 || amount > 100000) {
          return Response.json({ error: 'Сумма 1–100 000' }, { status: 400, headers: cors });
        }

        const tgResp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/createInvoiceLink`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: `Пополнение на ${amount} ★`,
            description: `Баланс EndlessBet пополнится на ${amount} звёзд.`,
            payload: `topup:custom:${user_id}`,
            currency: 'XTR',
            prices: [{ label: `${amount} звёзд`, amount: amount }],
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

        const upd = await env.DB.prepare(`
          UPDATE users SET
            balance = balance - ?,
            withdrawable = withdrawable - ?
          WHERE user_id = ? AND withdrawable >= ?
        `).bind(amount, amount, user_id, amount).run();

        if (!upd.meta || upd.meta.changes === 0) {
          return Response.json({ error: 'Недостаточно доступных для вывода' }, { status: 400, headers: cors });
        }

        await env.DB.prepare(
          'INSERT INTO withdrawals (user_id, amount, status) VALUES (?, ?, "pending")'
        ).bind(user_id, amount).run();

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
