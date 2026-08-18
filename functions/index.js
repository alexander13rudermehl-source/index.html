/**
 * Серверная часть «Тролль-баттл».
 *
 * До этого файла роль/значки/очки/баны менялись прямо из браузера через
 * db.ref(...).set(...) — а проверка "ты супердоступ?" делалась в JS,
 * который выполняется В БРАУЗЕРЕ ПОЛЬЗОВАТЕЛЯ. Это значит, что ЛЮБОЙ
 * человек мог открыть консоль разработчика (F12) и одной строчкой кода
 * выдать себе супердоступ, любые значки и любое число очков — потому что
 * ничего на сервере это не проверяло.
 *
 * Здесь все эти действия перенесены на сервер (Cloud Functions), а
 * db.rules.json запрещает клиенту писать напрямую в чувствительные поля.
 * Дальше проверка роли ("ты правда супердоступ?") идёт по данным из
 * Realtime Database, а не по тому, что написал сам браузер пользователя.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp({
  databaseURL: 'https://zolotaya-kletka-default-rtdb.firebaseio.com'
});
const db = admin.database();

// Токен бота хранится как секрет Cloud Functions, а не в коде — задать его
// один раз командой (см. инструкцию в конце файла):
//   firebase functions:secrets:set TELEGRAM_BOT_TOKEN
const TELEGRAM_BOT_TOKEN = defineSecret('TELEGRAM_BOT_TOKEN');

// ===== проверка подписи Telegram initData =====
// Алгоритм ровно по документации Telegram: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
function verifyInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const pairs = [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // сравнение постоянного времени — чтобы не давать возможность подобрать
  // хеш по времени ответа сервера
  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = parseInt(params.get('auth_date') || '0', 10);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!authDate || ageSeconds > 86400 || ageSeconds < -60) return null; // старше суток или из будущего — не доверяем

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson);
  } catch (e) {
    return null;
  }
}

function generatePlayerId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без похожих символов (0/O, 1/I)
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'PLR-' + code;
}

async function logAction(actorUid, actionType, targetKey, targetName, targetPlayerId, details) {
  const actorSnap = await db.ref('users/' + actorUid).get();
  const actor = actorSnap.val() || {};
  await db.ref('logs').push({
    timestamp: Date.now(),
    actorPlayerId: actor.playerId || '—',
    actorName: actor.firstName || '—',
    actionType,
    targetKey,
    targetName,
    targetPlayerId,
    details: details || ''
  });
}

// Читает РЕАЛЬНУЮ роль вызывающего прямо из базы (не из токена — токен
// может быть устаревшим, если роль поменяли только что) и бросает ошибку,
// если её нет в списке разрешённых.
async function requireRole(uid, allowedRoles) {
  const snap = await db.ref('users/' + uid + '/role').get();
  const role = snap.val() || 'user';
  if (!allowedRoles.includes(role)) {
    throw new HttpsError('permission-denied', 'Недостаточно прав для этого действия');
  }
  return role;
}

// ===== вход: проверка initData → создание/чтение профиля → custom token =====
exports.verifyTelegramLogin = onCall({ secrets: [TELEGRAM_BOT_TOKEN] }, async (request) => {
  const initData = request.data?.initData;
  if (!initData || typeof initData !== 'string') {
    throw new HttpsError('invalid-argument', 'initData отсутствует');
  }

  const tgUser = verifyInitData(initData, TELEGRAM_BOT_TOKEN.value());
  if (!tgUser || !tgUser.id) {
    throw new HttpsError('permission-denied', 'Подпись initData недействительна или устарела — открой приложение заново из Telegram');
  }

  const uid = String(tgUser.id);
  const userRef = db.ref('users/' + uid);
  const snap = await userRef.get();
  let role = 'user';

  if (snap.exists()) {
    role = snap.val().role || 'user';
    // имя/username могли поменяться в Telegram — подтягиваем свежие
    await userRef.update({
      firstName: tgUser.first_name || snap.val().firstName || 'Гость',
      username: tgUser.username ? '@' + tgUser.username : null
    });
  } else {
    const userData = {
      playerId: generatePlayerId(),
      firstName: tgUser.first_name || 'Гость',
      username: tgUser.username ? '@' + tgUser.username : null,
      role: 'user',
      points: 0,
      starsBalance: 0,
      stats: { battles: 0, wins: 0, losses: 0, draws: 0, refereeBattles: 0, audienceLikes: 0 },
      avatarData: null,
      status: 'active',
      restrictedUntil: null,
      createdAt: Date.now()
    };
    await userRef.set(userData);
  }

  // custom claims — чтобы database.rules.json тоже могли проверять роль
  // (auth.token.role), не только сами функции ниже
  await admin.auth().setCustomUserClaims(uid, { role }).catch(() => {
    // у пользователя ещё может не быть Auth-аккаунта на этот момент —
    // createCustomToken ниже создаст его автоматически, тогда claims
    // применятся уже при следующем логине
  });

  const token = await admin.auth().createCustomToken(uid, { role });
  return { token, uid };
});

// ===== профиль для гостя вне Telegram (анонимный вход) =====
// Для Telegram-пользователей запись создаёт verifyTelegramLogin выше, а
// анонимным гостям (открыли не из Telegram — например, тестируем в обычном
// браузере) запись тоже нужно создать на сервере, а не в браузере: клиенту
// запрещено писать в role/status/playerId напрямую (см. database.rules.json).
exports.ensureGuestProfile = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  const uid = request.auth.uid;
  const userRef = db.ref('users/' + uid);
  const snap = await userRef.get();
  if (!snap.exists()) {
    await userRef.set({
      playerId: generatePlayerId(),
      firstName: 'Гость',
      username: null,
      role: 'user',
      points: 0,
      starsBalance: 0,
      stats: { battles: 0, wins: 0, losses: 0, draws: 0, refereeBattles: 0, audienceLikes: 0 },
      avatarData: null,
      status: 'active',
      restrictedUntil: null,
      createdAt: Date.now()
    });
  }
  return { ok: true };
});

// ===== смена роли — только супердоступ =====
exports.adminSetRole = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  await requireRole(request.auth.uid, ['superadmin']);

  const { targetUid, newRole, targetName, targetPlayerId } = request.data || {};
  const allowedRoles = ['user', 'moderator', 'admin', 'superadmin'];
  if (!targetUid || !allowedRoles.includes(newRole)) {
    throw new HttpsError('invalid-argument', 'Некорректные параметры');
  }

  await db.ref('users/' + targetUid + '/role').set(newRole);
  await admin.auth().setCustomUserClaims(targetUid, { role: newRole }).catch(() => {});
  await logAction(request.auth.uid, 'role_change', targetUid, targetName, targetPlayerId, `Новая роль: ${newRole}`);
  return { ok: true };
});

// ===== выдача / отзыв значка — только супердоступ =====
exports.adminToggleBadge = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  await requireRole(request.auth.uid, ['superadmin']);

  const { targetUid, badgeKey, grant, targetName, targetPlayerId } = request.data || {};
  if (!targetUid || !badgeKey) throw new HttpsError('invalid-argument', 'Некорректные параметры');

  const badgeRef = db.ref(`users/${targetUid}/badges/${badgeKey}`);
  if (grant) await badgeRef.set(true);
  else await badgeRef.remove();

  const catalogSnap = await db.ref('badgeCatalog/' + badgeKey).get();
  const label = (catalogSnap.val() || {}).label || badgeKey;
  await logAction(
    request.auth.uid,
    grant ? 'badge_grant' : 'badge_revoke',
    targetUid, targetName, targetPlayerId,
    grant ? `Выдан значок: ${label}` : `Забран значок: ${label}`
  );
  return { ok: true };
});

// ===== создание нового значка в общем каталоге — только супердоступ =====
exports.adminCreateBadge = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  await requireRole(request.auth.uid, ['superadmin']);

  const { label, icon } = request.data || {};
  const cleanLabel = (label || '').trim();
  if (!cleanLabel) throw new HttpsError('invalid-argument', 'Нужно название значка');

  const key = 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await db.ref('badgeCatalog/' + key).set({ label: cleanLabel, icon: (icon || '🏅').trim() || '🏅' });
  await logAction(request.auth.uid, 'badge_create', key, cleanLabel, '', `Новый значок в каталоге: ${icon || '🏅'} ${cleanLabel}`);
  return { ok: true, key };
});

// ===== правка очков / звёзд / статистики — админ и супердоступ =====
exports.adminAdjustStats = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  await requireRole(request.auth.uid, ['admin', 'superadmin']);

  const { targetUid, points, starsBalance, stats, targetName, targetPlayerId } = request.data || {};
  if (!targetUid) throw new HttpsError('invalid-argument', 'Не указан игрок');

  const updates = {};
  if (Number.isFinite(points)) updates.points = points;
  if (Number.isFinite(starsBalance)) updates.starsBalance = starsBalance;
  if (stats && typeof stats === 'object') {
    for (const k of ['battles', 'wins', 'losses', 'draws', 'refereeBattles', 'audienceLikes']) {
      if (Number.isFinite(stats[k])) updates[`stats/${k}`] = stats[k];
    }
  }
  if (!Object.keys(updates).length) throw new HttpsError('invalid-argument', 'Нет данных для сохранения');

  await db.ref('users/' + targetUid).update(updates);
  await logAction(request.auth.uid, 'stats_change', targetUid, targetName, targetPlayerId, 'Статистика изменена администратором');
  return { ok: true };
});

// ===== бан / ограничение / снятие — модератор и выше =====
exports.adminSetBanStatus = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Нужна авторизация');
  await requireRole(request.auth.uid, ['moderator', 'admin', 'superadmin']);

  const { targetUid, mode, hours, targetName, targetPlayerId } = request.data || {}; // mode: 'restrict' | 'ban' | 'unban'
  if (!targetUid || !['restrict', 'ban', 'unban'].includes(mode)) {
    throw new HttpsError('invalid-argument', 'Некорректные параметры');
  }

  let updates, actionType, details;
  if (mode === 'restrict') {
    const h = Number.isFinite(hours) && hours > 0 ? hours : 24;
    updates = { status: 'restricted', restrictedUntil: Date.now() + h * 3600000 };
    actionType = 'ban_temp'; details = `Ограничение на ${h} ч.`;
  } else if (mode === 'ban') {
    updates = { status: 'banned', restrictedUntil: null };
    actionType = 'ban_forever'; details = 'Забанен навсегда';
  } else {
    updates = { status: 'active', restrictedUntil: null };
    actionType = 'unban'; details = 'Бан/ограничение снято';
  }

  await db.ref('users/' + targetUid).update(updates);
  await logAction(request.auth.uid, actionType, targetUid, targetName, targetPlayerId, details);
  return { ok: true };
});

/**
 * ===== ДЕПЛОЙ (сделать один раз) =====
 *
 * 1) Установить Firebase CLI, если ещё нет:
 *      npm install -g firebase-tools
 *
 * 2) Из корня проекта (папка с firebase.json, рядом с папкой functions/):
 *      firebase login
 *      firebase use zolotaya-kletka
 *
 * 3) Задать секрет с токеном бота (спросит значение в интерактивном режиме,
 *    само значение никуда не попадёт в код и в git):
 *      firebase functions:secrets:set TELEGRAM_BOT_TOKEN
 *
 * 4) Установить зависимости и задеплоить:
 *      cd functions && npm install && cd ..
 *      firebase deploy --only functions
 *
 * 5) Задеплоить обновлённые правила базы данных:
 *      firebase deploy --only database
 */
