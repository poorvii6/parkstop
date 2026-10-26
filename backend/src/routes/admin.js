// Admin-only views for the ParkStop website: every booking, user and spot,
// spot moderation and dispute handling. Read-mostly; nothing here changes how
// bookings, payments or payouts work. The mobile app does not call these.
const express = require('express');
const prisma = require('../config/prisma');
const logger = require('../utils/logger');
const { authenticate, authorize } = require('../middleware/auth');
const NotificationService = require('../services/notificationService');

const router = express.Router();
router.use(authenticate, authorize('ADMIN'));

const n = (d) => (d === null || d === undefined ? 0 : Number(d));
const clean = (q) => String(q || '').trim().slice(0, 80);
const fail = (res, code, message) => res.status(code).json({ success: false, message });

/** GET /admin/bookings?status=&q=  — latest 150 bookings, newest first. */
router.get('/bookings', async (req, res) => {
  try {
    const status = clean(req.query.status);
    const q = clean(req.query.q);
    const where = {};
    if (['reserved', 'active', 'checkout_pending', 'completed', 'cancelled', 'expired'].includes(status)) where.status = status;
    if (status === 'unpaid') { where.status = 'completed'; where.payment_status = { not: 'paid' }; }
    if (q) {
      const id = parseInt(q, 10);
      where.OR = [
        ...(Number.isFinite(id) ? [{ id }] : []),
        { users: { email: { contains: q, mode: 'insensitive' } } },
        { users: { full_name: { contains: q, mode: 'insensitive' } } },
        { parking_spots: { title: { contains: q, mode: 'insensitive' } } },
      ];
    }
    const rows = await prisma.bookings.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 150,
      include: {
        users: { select: { id: true, full_name: true, email: true } },
        parking_spots: { select: { id: true, title: true, users: { select: { id: true, full_name: true } } } },
      },
    });
    res.json({
      success: true,
      data: rows.map((b) => ({
        id: b.id, status: b.status, payment_status: b.payment_status, payment_id: b.payment_id,
        slot_name: b.slot_name, vehicle_type: b.vehicle_type,
        start_time: b.start_time, end_time: b.end_time, actual_end_time: b.actual_end_time, created_at: b.created_at,
        hours: n(b.hours), total_price: n(b.total_price), platform_fee: n(b.platform_fee), spotter_earning: n(b.spotter_earning),
        finder: b.users ? { id: b.users.id, name: b.users.full_name, email: b.users.email } : null,
        spot: b.parking_spots ? { id: b.parking_spots.id, title: b.parking_spots.title } : null,
        owner: b.parking_spots && b.parking_spots.users ? { id: b.parking_spots.users.id, name: b.parking_spots.users.full_name } : null,
      })),
    });
  } catch (err) { logger.error('Admin bookings error:', err); fail(res, 500, 'Could not load bookings.'); }
});

/** GET /admin/users?q=  — latest 150 users with their activity counts. */
router.get('/users', async (req, res) => {
  try {
    const q = clean(req.query.q);
    const where = q ? { OR: [{ email: { contains: q, mode: 'insensitive' } }, { full_name: { contains: q, mode: 'insensitive' } }, { phone: { contains: q } }] } : {};
    const rows = await prisma.users.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 150,
      select: {
        id: true, full_name: true, email: true, phone: true, role: true, created_at: true, balance: true,
        is_finder_registered: true, is_spotter_registered: true, verification_status: true,
        _count: { select: { bookings: true, parking_spots: true } },
      },
    });
    res.json({
      success: true,
      data: rows.map((u) => ({
        id: u.id, name: u.full_name, email: u.email, phone: u.phone, role: u.role, created_at: u.created_at,
        balance: n(u.balance), finder: u.is_finder_registered !== false, owner: !!u.is_spotter_registered,
        verification_status: u.verification_status, bookings: u._count.bookings, spots: u._count.parking_spots,
      })),
    });
  } catch (err) { logger.error('Admin users error:', err); fail(res, 500, 'Could not load users.'); }
});

/** GET /admin/spots?q=&show=all|live|hidden|deleted */
router.get('/spots', async (req, res) => {
  try {
    const q = clean(req.query.q);
    const show = clean(req.query.show) || 'all';
    const where = {};
    if (show === 'live') { where.is_active = true; where.deleted_at = null; }
    if (show === 'hidden') { where.is_active = false; where.deleted_at = null; }
    if (show === 'deleted') where.deleted_at = { not: null };
    if (show === 'all') where.deleted_at = null;
    if (q) where.OR = [{ title: { contains: q, mode: 'insensitive' } }, { address: { contains: q, mode: 'insensitive' } }];
    const rows = await prisma.parking_spots.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: 200,
      include: { users: { select: { id: true, full_name: true, email: true, verification_status: true } }, _count: { select: { bookings: true } } },
    });
    res.json({
      success: true,
      data: rows.map((s) => ({
        id: s.id, title: s.title, address: s.address, latitude: n(s.latitude), longitude: n(s.longitude),
        price_per_hour: n(s.price_per_hour), total_slots: s.total_slots, is_active: !!s.is_active, deleted_at: s.deleted_at,
        images: Array.isArray(s.images) ? s.images : [], created_at: s.created_at, bookings: s._count.bookings,
        owner: s.users ? { id: s.users.id, name: s.users.full_name, email: s.users.email, verification_status: s.users.verification_status } : null,
      })),
    });
  } catch (err) { logger.error('Admin spots error:', err); fail(res, 500, 'Could not load spots.'); }
});

/** POST /admin/spots/:id/remove {reason}  — take a listing down (marks it deleted). */
router.post('/spots/:id/remove', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const reason = clean(req.body && req.body.reason);
    if (reason.length < 5) return fail(res, 400, 'Give the owner a short reason (at least 5 characters).');
    const open = await prisma.bookings.count({ where: { spot_id: id, status: { in: ['reserved', 'active', 'checkout_pending'] } } });
    if (open) return fail(res, 409, 'This spot has a booking in progress. Try again after it finishes.');
    const s = await prisma.parking_spots.update({ where: { id }, data: { is_active: false, deleted_at: new Date(), updated_at: new Date() } });
    if (s.spotter_id) {
      NotificationService.sendPushNotification(s.spotter_id, { title: 'Listing removed', body: `"${s.title}" was removed by ParkStop. Reason: ${reason}`, data: { type: 'spot_removed', spotId: id } }).catch(() => {});
    }
    logger.info(`Admin ${req.user.id} removed spot ${id}: ${reason}`);
    res.json({ success: true, message: 'Listing removed. The owner has been told.' });
  } catch (err) { logger.error('Admin remove spot error:', err); fail(res, 500, 'Could not remove the listing.'); }
});

/** POST /admin/spots/:id/restore  — undo a removal (spot comes back offline). */
router.post('/spots/:id/restore', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await prisma.parking_spots.update({ where: { id }, data: { deleted_at: null, is_active: false, updated_at: new Date() } });
    res.json({ success: true, message: 'Listing restored. The owner can switch it on again.' });
  } catch (err) { logger.error('Admin restore spot error:', err); fail(res, 500, 'Could not restore the listing.'); }
});

/** GET /admin/disputes?status=open|resolved */
router.get('/disputes', async (req, res) => {
  try {
    const status = clean(req.query.status) === 'resolved' ? 'resolved' : 'open';
    const rows = await prisma.disputes.findMany({
      where: { status },
      orderBy: { created_at: status === 'open' ? 'asc' : 'desc' },
      take: 100,
      include: {
        user: { select: { id: true, full_name: true, email: true } },
        bookings: { select: { id: true, status: true, total_price: true, payment_status: true, start_time: true, actual_end_time: true, parking_spots: { select: { title: true } } } },
      },
    });
    res.json({
      success: true,
      data: rows.map((d) => ({
        id: d.id, booking_id: d.booking_id, reason: d.reason, description: d.description, status: d.status, resolution: d.resolution,
        created_at: d.created_at, updated_at: d.updated_at,
        raised_by: d.user ? { id: d.user.id, name: d.user.full_name, email: d.user.email } : null,
        booking: d.bookings ? { id: d.bookings.id, status: d.bookings.status, total_price: n(d.bookings.total_price), payment_status: d.bookings.payment_status, spot: d.bookings.parking_spots ? d.bookings.parking_spots.title : null, start_time: d.bookings.start_time, end_time: d.bookings.actual_end_time } : null,
      })),
    });
  } catch (err) { logger.error('Admin disputes error:', err); fail(res, 500, 'Could not load disputes.'); }
});

/** POST /admin/disputes/:id/resolve {resolution} */
router.post('/disputes/:id/resolve', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const resolution = String((req.body && req.body.resolution) || '').trim().slice(0, 500);
    if (resolution.length < 5) return fail(res, 400, 'Write what was decided (at least 5 characters).');
    const claimed = await prisma.disputes.updateMany({ where: { id, status: 'open' }, data: { status: 'resolved', resolution, updated_at: new Date() } });
    if (!claimed.count) return fail(res, 409, 'This dispute was already resolved.');
    const d = await prisma.disputes.findUnique({ where: { id } });
    NotificationService.sendPushNotification(d.raised_by, { title: 'Your report was reviewed', body: resolution.slice(0, 140), data: { type: 'dispute_resolved', bookingId: d.booking_id } }).catch(() => {});
    res.json({ success: true, message: 'Marked resolved. The person who reported it has been told.' });
  } catch (err) { logger.error('Admin resolve dispute error:', err); fail(res, 500, 'Could not update the dispute.'); }
});

module.exports = router;
