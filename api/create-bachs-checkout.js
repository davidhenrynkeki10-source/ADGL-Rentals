import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

const properties = {
  'apartment-1': {
    name: 'LightGate Unit',
    rate: 150000,
    caution: 100000,
    maxGuests: 4
  },

  'apartment-2': {
    name: 'Richmond Unit',
    rate: 250000,
    caution: 100000,
    maxGuests: 4
  }
};

function calculateNights(checkIn, checkOut) {
  const start = new Date(`${checkIn}T00:00:00Z`);
  const end = new Date(`${checkOut}T00:00:00Z`);

  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime())
  ) {
    return 0;
  }

  return Math.round(
    (end.getTime() - start.getTime()) / 86400000
  );
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
    const {
      apartmentId,
      checkIn,
      checkOut,
      guests,
      customerName,
      customerEmail,
      customerPhone
    } = req.body || {};

    // -----------------------------------
    // 1. Validate the selected property
    // -----------------------------------

    const property = properties[apartmentId];

    if (!property) {
      return res.status(400).json({
        success: false,
        message: 'Invalid property'
      });
    }

    // -----------------------------------
    // 2. Validate customer information
    // -----------------------------------

    if (
      !customerName?.trim() ||
      !customerEmail?.trim() ||
      !customerPhone?.trim()
    ) {
      return res.status(400).json({
        success: false,
        message: 'Customer details are required'
      });
    }

    // -----------------------------------
    // 3. Validate guests
    // -----------------------------------

    const guestCount = Number(guests);

    if (
      !Number.isInteger(guestCount) ||
      guestCount < 1 ||
      guestCount > property.maxGuests
    ) {
      return res.status(400).json({
        success: false,
        message: `Guests must be between 1 and ${property.maxGuests}`
      });
    }

    // -----------------------------------
    // 4. Calculate nights SERVER-SIDE
    // -----------------------------------

    const nights = calculateNights(checkIn, checkOut);

    if (nights < 1) {
      return res.status(400).json({
        success: false,
        message: 'Check-out must be after check-in'
      });
    }

    // -----------------------------------
    // 5. Calculate price SERVER-SIDE
    // -----------------------------------

    const expectedAmount =
      nights * property.rate + property.caution;

    // -----------------------------------
    // 6. Recheck availability
    // -----------------------------------

    const { data: overlappingBookings, error: availabilityError } =
      await supabase
        .from('Bookings')
        .select('id')
        .eq('apartment_id', apartmentId)
        .eq('booking_status', 'confirmed')
        .lt('check_in', checkOut)
        .gt('check_out', checkIn)
        .limit(1);

    if (availabilityError) {
      console.error(
        'Supabase availability error:',
        availabilityError
      );

      return res.status(500).json({
        success: false,
        message: 'Unable to check availability'
      });
    }

    if (overlappingBookings?.length) {
      return res.status(409).json({
        success: false,
        message:
          'These dates are no longer available. Please choose different dates.'
      });
    }

    // -----------------------------------
    // 7. Generate our own reference
    // -----------------------------------

    const reference =
      `ADGL-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    // -----------------------------------
    // 8. Create Bachs live checkout
    // -----------------------------------

    const auth = Buffer.from(
      `${process.env.BACHS_SECRET_KEY}:`
    ).toString('base64');

    const bachsResponse = await fetch(
      'https://api.bachs.io/v1/checkout-sessions',
      {
        method: 'POST',

        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json'
        },

        body: JSON.stringify({
          pricing: {
            amount: expectedAmount.toFixed(2),
            currency: 'NGN'
          },

          reference
        })
      }
    );

    const bachsData = await bachsResponse.json();

    if (!bachsResponse.ok) {
      console.error('Bachs checkout error:', bachsData);

      return res.status(502).json({
        success: false,
        message: 'Unable to create payment checkout'
      });
    }

    if (!bachsData.checkout_id || !bachsData.checkout_url) {
      console.error(
        'Unexpected Bachs checkout response:',
        bachsData
      );

      return res.status(502).json({
        success: false,
        message: 'Invalid checkout response from payment provider'
      });
    }

    // -----------------------------------
// 9. Store pending booking securely
// -----------------------------------

const { error: pendingBookingError } = await supabase
  .from('PendingBookings')
  .insert({
    reference,
    checkout_id: bachsData.checkout_id,

    apartment_id: apartmentId,
    check_in: checkIn,
    check_out: checkOut,

    guests: guestCount,
    nights,

    expected_amount: expectedAmount,
    currency: 'NGN',

    customer_name: customerName.trim(),
    customer_email: customerEmail.trim().toLowerCase(),
    customer_phone: customerPhone.trim(),

    status: 'pending'
  });

if (pendingBookingError) {
  console.error(
    'Pending booking insert error:',
    pendingBookingError
  );

  return res.status(500).json({
    success: false,
    message: 'Unable to prepare booking for payment'
  });
}

    // -----------------------------------
    // 10. Return checkout information
    // -----------------------------------

    return res.status(200).json({
      success: true,

      checkoutId: bachsData.checkout_id,
      checkoutUrl: bachsData.checkout_url,

      reference,

      booking: {
        property: property.name,
        nights,
        amount: expectedAmount,
        currency: 'NGN'
      }
    });

  } catch (error) {
    console.error(
      'Create Bachs checkout error:',
      error
    );

    return res.status(500).json({
      success: false,
      message: 'Unable to start payment'
    });
  }
}