export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Method not allowed'
    });
  }

  try {
    const {
      reference,
      checkin,
      checkout,
      guests
    } = req.body;

    if (!reference || !checkin || !checkout) {
      return res.status(400).json({
        verified: false,
        message: 'Missing booking information'
      });
    }

    // -----------------------------
    // 1. CALCULATE BOOKING PRICE
    // -----------------------------

    const checkinDate = new Date(checkin + 'T00:00:00Z');
    const checkoutDate = new Date(checkout + 'T00:00:00Z');

    const nights = Math.round(
      (checkoutDate - checkinDate) / (1000 * 60 * 60 * 24)
    );

    if (nights <= 0) {
      return res.status(400).json({
        verified: false,
        message: 'Invalid booking dates'
      });
    }

    const rate = 150000;
    const caution = 100000;

    const expectedAmountNaira = (nights * rate) + caution;

    // Paystack amount is returned in kobo
    const expectedAmountKobo = expectedAmountNaira * 100;


    // -----------------------------
    // 2. VERIFY WITH PAYSTACK
    // -----------------------------

    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const payment = await paystackResponse.json();

    if (
      !paystackResponse.ok ||
      payment.status !== true ||
      !payment.data ||
      payment.data.status !== 'success'
    ) {
      return res.status(400).json({
        verified: false,
        message: 'Payment could not be verified'
      });
    }


    // -----------------------------
    // 3. VERIFY AMOUNT + CURRENCY
    // -----------------------------

    if (
      Number(payment.data.amount) !== expectedAmountKobo ||
      payment.data.currency !== 'NGN'
    ) {
      return res.status(400).json({
        verified: false,
        message: 'Payment amount does not match booking amount'
      });
    }


    // -----------------------------
    // 4. CHECK IF PAYMENT WAS
    //    ALREADY USED
    // -----------------------------

    const existingReferenceResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/Bookings?payment_reference=eq.${encodeURIComponent(reference)}&select=id`,
      {
        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
        }
      }
    );

    const existingReference = await existingReferenceResponse.json();

    if (!existingReferenceResponse.ok) {
      console.error('Reference check failed:', existingReference);

      return res.status(500).json({
        verified: false,
        message: 'Unable to check booking reference'
      });
    }

    if (existingReference.length > 0) {
  return res.status(200).json({
    verified: true,
    bookingCreated: true,
    booking: existingReference[0],
    message: 'Booking already confirmed'
  });
}


    // -----------------------------
    // 5. CHECK AVAILABILITY AGAIN
    // -----------------------------

    const availabilityURL =
      `${process.env.SUPABASE_URL}/rest/v1/Bookings` +
      `?apartment_id=eq.apartment-1` +
      `&booking_status=eq.confirmed` +
      `&check_in=lt.${encodeURIComponent(checkout)}` +
      `&check_out=gt.${encodeURIComponent(checkin)}` +
      `&select=id`;

    const availabilityResponse = await fetch(availabilityURL, {
      headers: {
        apikey: process.env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`
      }
    });

    const overlappingBookings = await availabilityResponse.json();

    if (!availabilityResponse.ok) {
      console.error('Availability check failed:', overlappingBookings);

      return res.status(500).json({
        verified: false,
        message: 'Unable to check availability'
      });
    }

    if (overlappingBookings.length > 0) {
      return res.status(409).json({
        verified: true,
        bookingCreated: false,
        message:
          'Payment was successful, but these dates are no longer available. Please contact support.'
      });
    }


    // -----------------------------
    // 6. CREATE CONFIRMED BOOKING
    // -----------------------------

    const bookingResponse = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/Bookings`,
      {
        method: 'POST',

        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },

        body: JSON.stringify({
          apartment_id: 'apartment-1',

          check_in: checkin,
          check_out: checkout,

          guests: Number(guests) || 1,
          nights: nights,

          amount: expectedAmountNaira,

          payment_status: 'paid',
          booking_status: 'confirmed',

          payment_reference: reference
        })
      }
    );

    const booking = await bookingResponse.json();

    if (!bookingResponse.ok) {
      console.error('Booking creation failed:', booking);

      return res.status(500).json({
        verified: true,
        bookingCreated: false,
        message:
          'Payment was verified but the booking could not be created. Please contact support.'
      });
    }


    // -----------------------------
    // SUCCESS
    // -----------------------------

    return res.status(200).json({
      verified: true,
      bookingCreated: true,

      booking: booking[0],

      reference: payment.data.reference,

      message: 'Booking confirmed successfully'
    });

  } catch (error) {
    console.error('Booking verification error:', error);

    return res.status(500).json({
      verified: false,
      bookingCreated: false,
      message: 'Server error while confirming booking'
    });
  }
}