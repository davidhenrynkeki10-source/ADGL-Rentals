export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Method not allowed'
    });
  }

  try {
    const {
      bookingId,
      name,
      phone
    } = req.body;

    if (!bookingId || !name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Please provide all customer details'
      });
    }

    const response = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/Bookings?id=eq.${encodeURIComponent(bookingId)}`,
      {
        method: 'PATCH',

        headers: {
          apikey: process.env.SUPABASE_SECRET_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation'
        },

        body: JSON.stringify({
          customer_name: name.trim(),
          customer_phone: phone.trim()
        })
      }
    );

    const booking = await response.json();

    if (!response.ok) {
      console.error('Booking update failed:', booking);

      return res.status(500).json({
        success: false,
        message: 'Unable to update booking details'
      });
    }

    if (!booking || booking.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Booking not found'
      });
    }

    return res.status(200).json({
      success: true,
      booking: booking[0],
      message: 'Booking details saved successfully'
    });

  } catch (error) {
    console.error('Complete booking error:', error);

    return res.status(500).json({
      success: false,
      message: 'Server error while completing booking'
    });
  }
}