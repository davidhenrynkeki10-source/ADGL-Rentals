import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const config = {
  api: {
    bodyParser: false
  }
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyBachsSignature(
  rawBody,
  secret,
  timestampHeader,
  signatureHeader
) {
  if (!secret || !timestampHeader || !signatureHeader) {
    return false;
  }

  const timestamp = Number(timestampHeader);

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  // Reject deliveries older/newer than 5 minutes.
  if (Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return false;
  }

  const message =
    `${timestamp}.${rawBody.toString('utf8')}`;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(message, 'utf8')
    .digest('hex');

  const expected = Buffer.from(expectedSignature, 'utf8');
  const received = Buffer.from(signatureHeader, 'utf8');

  if (expected.length !== received.length) {
    return false;
  }

  return crypto.timingSafeEqual(expected, received);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');

    return res.status(405).json({
      success: false,
      message: 'Method not allowed'
    });
  }

  try {
    // -----------------------------------
    // 1. Read RAW body
    // -----------------------------------

    const rawBody = await readRawBody(req);

    const timestampHeader =
      req.headers['x-bachs-timestamp'];

    const signatureHeader =
      req.headers['x-bachs-signature'];

    // -----------------------------------
    // 2. Verify Bachs signature
    // -----------------------------------

    const signatureIsValid = verifyBachsSignature(
      rawBody,
      process.env.BACHS_WEBHOOK_SECRET,
      timestampHeader,
      signatureHeader
    );

    if (!signatureIsValid) {
      console.error('Invalid Bachs webhook signature');

      return res.status(401).json({
        success: false,
        message: 'Invalid signature'
      });
    }

    // Parse only AFTER signature verification.
    let event;

    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return res.status(400).json({
        success: false,
        message: 'Invalid JSON'
      });
    }

    // -----------------------------------
    // 3. Only process successful collections
    // -----------------------------------

    if (event.type !== 'collection.succeeded') {
      return res.status(200).json({
        received: true
      });
    }

    if (!event.id || !event.data) {
      return res.status(400).json({
        success: false,
        message: 'Invalid event payload'
      });
    }

    const data = event.data;

    const reference = data.reference || null;
    const checkoutId = data.checkout_id || null;

    if (!reference && !checkoutId) {
      console.error(
        'Collection has no checkout/reference:',
        event.id
      );

      return res.status(400).json({
        success: false,
        message: 'Unable to identify booking'
      });
    }

    // -----------------------------------
    // 4. Locate our pending booking
    // -----------------------------------

    let query = supabase
      .from('PendingBookings')
      .select('*');

    if (reference) {
      query = query.eq('reference', reference);
    } else {
      query = query.eq('checkout_id', checkoutId);
    }

    const {
      data: pendingBooking,
      error: pendingError
    } = await query.maybeSingle();

    if (pendingError) {
      console.error(
        'Pending booking lookup error:',
        pendingError
      );

      return res.status(500).json({
        success: false
      });
    }

    if (!pendingBooking) {
      console.error(
        'No pending booking found:',
        reference || checkoutId
      );

      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    // -----------------------------------
    // 5. Idempotency / duplicate delivery
    // -----------------------------------

    if (pendingBooking.status === 'paid') {
  if (
    pendingBooking.bachs_event_id &&
    pendingBooking.bachs_event_id !== event.id
  ) {
    console.error(
      'Paid booking received a different Bachs event:',
      {
        reference: pendingBooking.reference,
        storedEventId: pendingBooking.bachs_event_id,
        receivedEventId: event.id
      }
    );

    return res.status(409).json({
      success: false,
      message: 'Payment event mismatch'
    });
  }

  return res.status(200).json({
    received: true,
    duplicate: true
  });
}

// Extra idempotency protection:
// check whether this payment reference already created a booking.
const {
  data: existingBooking,
  error: existingBookingError
} = await supabase
  .from('Bookings')
  .select('id')
  .eq('payment_reference', pendingBooking.reference)
  .maybeSingle();

if (existingBookingError) {
  console.error(
    'Existing booking lookup error:',
    existingBookingError
  );

  return res.status(500).json({
    success: false
  });
}

if (existingBooking) {
  // The booking was already created during an earlier
  // delivery. Repair the PendingBookings status if needed.
  await supabase
    .from('PendingBookings')
    .update({
      status: 'paid',
      bachs_event_id: event.id,
      paid_at: pendingBooking.paid_at || new Date().toISOString()
    })
    .eq('id', pendingBooking.id);

  return res.status(200).json({
    received: true,
    duplicate: true
  });
}

    if (
      pendingBooking.bachs_event_id &&
      pendingBooking.bachs_event_id !== event.id
    ) {
      console.error(
        'Booking already associated with another Bachs event'
      );

      return res.status(409).json({
        success: false
      });
    }

    // -----------------------------------
    // 6. Verify checkout ID
    // -----------------------------------

    if (
      checkoutId &&
      pendingBooking.checkout_id !== checkoutId
    ) {
      console.error('Bachs checkout ID mismatch');

      return res.status(400).json({
        success: false,
        message: 'Checkout mismatch'
      });
    }

    // -----------------------------------
    // 7. Verify amount + currency
    // -----------------------------------

    const paidAmount = Number(data.amount);
    const expectedAmount =
      Number(pendingBooking.expected_amount);

    if (
      !Number.isFinite(paidAmount) ||
      paidAmount !== expectedAmount
    ) {
      console.error(
        'Bachs amount mismatch:',
        paidAmount,
        expectedAmount
      );

      return res.status(400).json({
        success: false,
        message: 'Payment amount mismatch'
      });
    }

    if (
      String(data.currency || '').toUpperCase() !==
      String(pendingBooking.currency).toUpperCase()
    ) {
      console.error('Bachs currency mismatch');

      return res.status(400).json({
        success: false,
        message: 'Payment currency mismatch'
      });
    }

    // -----------------------------------
    // 8. Recheck availability
    // -----------------------------------

    const {
      data: overlappingBookings,
      error: availabilityError
    } = await supabase
      .from('Bookings')
      .select('id')
      .eq(
        'apartment_id',
        pendingBooking.apartment_id
      )
      .eq('booking_status', 'confirmed')
      .lt('check_in', pendingBooking.check_out)
      .gt('check_out', pendingBooking.check_in)
      .limit(1);

    if (availabilityError) {
      console.error(
        'Final availability check failed:',
        availabilityError
      );

      return res.status(500).json({
        success: false
      });
    }

    if (overlappingBookings?.length) {
      console.error(
        'PAID booking has conflicting dates:',
        pendingBooking.reference
      );

      // Do NOT silently create an overlapping booking.
      // This payment will need manual attention/refund.
      return res.status(409).json({
        success: false,
        message: 'Paid booking requires manual review'
      });
    }

    // -----------------------------------
    // 9. Create confirmed booking
    // -----------------------------------

    const {
      error: bookingError
    } = await supabase
      .from('Bookings')
      .insert({
        apartment_id:
          pendingBooking.apartment_id,

        check_in:
          pendingBooking.check_in,

        check_out:
          pendingBooking.check_out,

        guests:
          pendingBooking.guests,

        nights:
          pendingBooking.nights,

        amount:
          pendingBooking.expected_amount,

        payment_status: 'paid',
        booking_status: 'confirmed',

        payment_reference:
          pendingBooking.reference,

        customer_name:
          pendingBooking.customer_name,

        customer_email:
          pendingBooking.customer_email,

        customer_phone:
          pendingBooking.customer_phone
      });

    if (bookingError) {
      // Your existing DB overlap constraint remains
      // the final protection against double booking.
      console.error(
        'Confirmed booking insert error:',
        bookingError
      );

      return res.status(500).json({
        success: false
      });
    }

    // -----------------------------------
    // 10. Mark pending booking as paid
    // -----------------------------------

    const {
      error: updateError
    } = await supabase
      .from('PendingBookings')
      .update({
        status: 'paid',
        bachs_event_id: event.id,
        paid_at: new Date().toISOString()
      })
      .eq('id', pendingBooking.id);

    if (updateError) {
      console.error(
        'Pending booking update error:',
        updateError
      );

      // Booking already exists, so returning an error
      // here could cause Bachs to retry and duplicate it.
      // Log for manual reconciliation instead.
    }

    // -----------------------------------
    // 11. Acknowledge Bachs
    // -----------------------------------

    return res.status(200).json({
      received: true
    });

  } catch (error) {
    console.error(
      'Bachs webhook error:',
      error
    );

    return res.status(500).json({
      success: false
    });
  }
}