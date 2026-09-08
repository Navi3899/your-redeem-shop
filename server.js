require("dotenv").config();
const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const Razorpay = require("razorpay");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const db = new Database("shop.db");
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  active INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  FOREIGN KEY(product_id) REFERENCES products(id)
);
CREATE TABLE IF NOT EXISTS codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id INTEGER NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'available',
  order_id TEXT,
  FOREIGN KEY(variant_id) REFERENCES variants(id)
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  variant_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  payment_id TEXT,
  status TEXT DEFAULT 'pending',
  code_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
`);

const count = db.prepare("SELECT COUNT(*) c FROM products").get().c;
if (!count) {
  const p = db.prepare("INSERT INTO products (name, description) VALUES (?, ?)").run(
    "Sample Game Pack", "Choose one of three redeem-code types."
  );
  const addV = db.prepare("INSERT INTO variants (product_id, name, price) VALUES (?, ?, ?)");
  const a = addV.run(p.lastInsertRowid, "Type 1", 100);
  const b = addV.run(p.lastInsertRowid, "Type 2", 150);
  const c = addV.run(p.lastInsertRowid, "Type 3", 200);
  const addC = db.prepare("INSERT INTO codes (variant_id, code) VALUES (?, ?)");
  addC.run(a.lastInsertRowid, "DEMO-TYPE1-001");
  addC.run(b.lastInsertRowid, "DEMO-TYPE2-001");
  addC.run(c.lastInsertRowid, "DEMO-TYPE3-001");
}

let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
  });
}

app.get("/api/products", (req,res) => {
  const products = db.prepare("SELECT * FROM products WHERE active=1 ORDER BY id DESC").all();
  for (const p of products) {
    p.variants = db.prepare(`
      SELECT v.*, COUNT(c.id) AS available
      FROM variants v LEFT JOIN codes c
      ON c.variant_id=v.id AND c.status='available'
      WHERE v.product_id=? GROUP BY v.id
    `).all(p.id);
  }
  res.json(products);
});

app.post("/api/create-order", async (req,res) => {
  try {
    const { variantId } = req.body;
    const v = db.prepare("SELECT * FROM variants WHERE id=?").get(variantId);
    if (!v) return res.status(404).json({error:"Product option not found"});
    const available = db.prepare(
      "SELECT id FROM codes WHERE variant_id=? AND status='available' LIMIT 1"
    ).get(variantId);
    if (!available) return res.status(409).json({error:"This code type is sold out"});

    const localId = "ORD-" + Date.now();
    if (!razorpay) {
      db.prepare("INSERT INTO orders (id,variant_id,amount) VALUES (?,?,?)")
        .run(localId, v.id, v.price);
      return res.json({mode:"demo", orderId:localId, amount:v.price});
    }

    const rp = await razorpay.orders.create({
      amount: v.price * 100,
      currency:"INR",
      receipt: localId
    });
    db.prepare("INSERT INTO orders (id,variant_id,amount) VALUES (?,?,?)")
      .run(rp.id, v.id, v.price);
    res.json({mode:"razorpay", orderId:rp.id, amount:v.price});
  } catch(e) {
    res.status(500).json({error:e.message});
  }
});

app.post("/api/demo-complete", (req,res) => {
  // Demo-only completion. Replace with verified payment webhook/signature handling
  // before accepting real money.
  deliverCode(req.body.orderId, res);
});

function deliverCode(orderId,res) {
  const order = db.prepare("SELECT * FROM orders WHERE id=?").get(orderId);
  if (!order) return res.status(404).json({error:"Order not found"});
  if (order.status === "paid" && order.code_id) {
    const code = db.prepare("SELECT code FROM codes WHERE id=?").get(order.code_id);
    return res.json({success:true, code:code.code});
  }

  const code = db.prepare(`
    SELECT * FROM codes
    WHERE variant_id=? AND status='available' LIMIT 1
  `).get(order.variant_id);
  if (!code) return res.status(409).json({error:"No unused redeem code remains"});

  const tx = db.transaction(() => {
    db.prepare("UPDATE codes SET status='sold', order_id=? WHERE id=?")
      .run(order.id, code.id);
    db.prepare("UPDATE orders SET status='paid', code_id=? WHERE id=?")
      .run(code.id, order.id);
  });
  tx();
  res.json({success:true, code:code.code});
}

app.post("/api/admin/product", (req,res) => {
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`)
    return res.status(401).json({error:"Unauthorized"});
  const {name, description, variants=[]} = req.body;
  const p = db.prepare("INSERT INTO products (name,description) VALUES (?,?)")
    .run(name, description || "");
  const addV = db.prepare("INSERT INTO variants (product_id,name,price) VALUES (?,?,?)");
  for (const v of variants) addV.run(p.lastInsertRowid, v.name, Number(v.price));
  res.json({id:p.lastInsertRowid});
});

app.post("/api/admin/code", (req,res) => {
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`)
    return res.status(401).json({error:"Unauthorized"});
  const {variantId, code} = req.body;
  db.prepare("INSERT INTO codes (variant_id,code) VALUES (?,?)").run(variantId, code);
  res.json({success:true});
});

app.get("*", (req,res) => res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(process.env.PORT || 3000, () =>
  console.log("Redeem shop running on http://localhost:"+(process.env.PORT || 3000))
);
