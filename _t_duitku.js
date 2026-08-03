const path = require('path');
const Module = require('module');

// --- Stub axios & settingsManager sebelum paymentService dimuat ---
const calls = [];
let handler = null;
const axiosStub = {
  post: async (url, body) => {
    calls.push({ url, body });
    return handler(url, body);
  }
};
require.cache[require.resolve('axios')] = { id:'axios', filename:'axios', loaded:true, exports: axiosStub };

const smPath = require.resolve('./config/settingsManager');
require.cache[smPath] = { id:smPath, filename:smPath, loaded:true, exports: {
  getSettingsWithCache: () => ({
    duitku_merchant_code: 'DS12345',
    duitku_api_key: 'RAHASIA',
    duitku_mode: 'sandbox',
    app_url: 'https://portal.elroundnet.my.id'
  })
}};

const pay = require('./services/paymentService');

function httpErr(status, data) {
  const e = new Error('Request failed'); e.response = { status, data }; return e;
}
const inv = { id: 7, amount: 2000, item_name: 'Voucher Hotspot 6Jam (6h)' };
const cust = { name: 'Pembeli Voucher', phone: '081234567890', email: '' };

async function run(label, h) {
  calls.length = 0; handler = h;
  process.stdout.write('\n=== ' + label + ' ===\n');
  try {
    const r = await pay.createDuitkuTransaction(inv, cust, 'BCAVA', '', {});
    console.log('HASIL  : sukses ->', r.link);
  } catch (e) {
    console.log('HASIL  : gagal  ->', e.message);
  }
  calls.forEach((c,i) => console.log(`  call#${i+1} ${c.url.split('/webapi')[1]}  paymentMethod=${c.body.paymentMethod ?? '(tidak dikirim)'}`));
}

(async () => {
  await run('A. Kanal BCAVA aktif', () => ({ data:{ paymentUrl:'https://sandbox.duitku.com/pay/OK' } }));

  await run('B. BCAVA ditolak 404 -> mundur ke halaman pilihan Duitku', (url, body) => {
    if (body.paymentMethod) throw httpErr(404, { Message: 'Payment channel not available' });
    return { data:{ paymentUrl:'https://sandbox.duitku.com/pay/PICKER' } };
  });

  await run('C. Semua ditolak -> laporkan kanal yang aktif', (url) => {
    if (url.includes('getpaymentmethod')) {
      return { data:{ paymentFee:[
        { paymentMethod:'SP', paymentName:'ShopeePay QRIS', totalFee:'0' },
        { paymentMethod:'OV', paymentName:'OVO', totalFee:'0' }
      ]}};
    }
    throw httpErr(404, { Message: 'Payment channel not available' });
  });

  await run('D. Semua ditolak & tidak ada kanal aktif (nominal terlalu kecil)', (url) => {
    if (url.includes('getpaymentmethod')) return { data:{ paymentFee: [] } };
    throw httpErr(404, { Message: 'Payment channel not available' });
  });

  // Tanda tangan getpaymentmethod
  calls.length = 0;
  handler = () => ({ data:{ paymentFee:[] } });
  await pay.getDuitkuPaymentMethods(2000);
  const b = calls[0].body;
  const crypto = require('crypto');
  const ok = crypto.createHash('sha256').update('DS12345' + b.amount + b.datetime + 'RAHASIA').digest('hex') === b.signature;
  console.log('\n=== E. getpaymentmethod ===');
  console.log('  amount   :', b.amount, '(tipe ' + typeof b.amount + ')');
  console.log('  datetime :', b.datetime);
  console.log('  signature cocok sha256(merchant+amount+datetime+apikey):', ok);
})();
