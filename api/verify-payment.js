export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({
      message: 'Method not allowed'
    });
  }

  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({
        message: 'Payment reference is required'
      });
    }

    // Verify the transaction directly with Paystack
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error('Paystack verification failed:', result);

      return res.status(400).json({
        verified: false,
        message: 'Unable to verify payment'
      });
    }

    // Make sure Paystack says the payment was successful
    if (
      result.status === true &&
      result.data &&
      result.data.status === 'success'
    ) {
      return res.status(200).json({
        verified: true,
        reference: result.data.reference,
        amount: result.data.amount,
        email: result.data.customer?.email
      });
    }

    return res.status(400).json({
      verified: false,
      message: 'Payment was not successful'
    });

  } catch (error) {
    console.error('Payment verification error:', error);

    return res.status(500).json({
      verified: false,
      message: 'Server error while verifying payment'
    });
  }
}