const dotenv = require("dotenv");
const { getPool } = require("../src/db");

dotenv.config();

async function hasTable(tableName) {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [tableName]
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

async function hasColumn(tableName, columnName) {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS cnt
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.cnt || 0) > 0;
}

async function getColumnMeta(tableName, columnName) {
  const [rows] = await getPool().query(
    `SELECT IS_NULLABLE AS is_nullable
     FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = ?
       AND column_name = ?
     LIMIT 1`,
    [tableName, columnName]
  );
  return rows[0] || null;
}

function truncate100(value) {
  return Math.floor(Number(value || 0) / 100) * 100;
}

async function ensureClient() {
  const [rows] = await getPool().query(
    `SELECT id
     FROM clients
     WHERE deleted_at IS NULL
     ORDER BY id ASC
     LIMIT 1`
  );
  if (rows.length > 0) return Number(rows[0].id);

  const [result] = await getPool().query(
    `INSERT INTO clients (client_code, name_kr, status)
     VALUES ('DEMO', 'Demo Client', 'active')`
  );
  return Number(result.insertId);
}

async function ensureAdminUser(clientId) {
  const [rows] = await getPool().query(
    `SELECT id
     FROM users
     WHERE role = 'admin'
       AND status = 'active'
       AND deleted_at IS NULL
     ORDER BY id ASC
     LIMIT 1`
  );
  if (rows.length > 0) return Number(rows[0].id);

  const [result] = await getPool().query(
    `INSERT INTO users (client_id, email, password_hash, name, role, status)
     VALUES (?, 'admin.demo@example.com', '1234', 'Demo Admin', 'admin', 'active')`,
    [clientId]
  );
  return Number(result.insertId);
}

async function upsertServiceRates() {
  if (!(await hasTable("service_catalog"))) return;

  const hasServiceName = await hasColumn("service_catalog", "service_name");
  const hasBillingUnit = await hasColumn("service_catalog", "billing_unit");
  const hasPricingPolicy = await hasColumn("service_catalog", "pricing_policy");
  const hasDefaultRate = await hasColumn("service_catalog", "default_rate");

  const rows = [
    {
      service_code: "OUTBOUND_FEE",
      service_name_kr: "출고 수수료",
      service_name: "Outbound Fee",
      billing_basis: "QTY",
      billing_unit: "SKU",
      pricing_policy: "KRW_FIXED",
      default_currency: "KRW",
      default_rate: 3500,
      status: "active",
    },
    {
      service_code: "TH_SHIPPING",
      service_name_kr: "태국 배송비",
      service_name: "TH Shipping",
      billing_basis: "ORDER",
      billing_unit: "ORDER",
      pricing_policy: "THB_BASED",
      default_currency: "THB",
      default_rate: 120,
      status: "active",
    },
    {
      service_code: "TH_BOX",
      service_name_kr: "박스비",
      service_name: "TH Box",
      billing_basis: "BOX",
      billing_unit: "BOX",
      pricing_policy: "THB_BASED",
      default_currency: "THB",
      default_rate: 8,
      status: "active",
    },
  ];

  for (const row of rows) {
    const columns = ["service_code", "service_name_kr", "billing_basis", "default_currency", "status"];
    const values = [row.service_code, row.service_name_kr, row.billing_basis, row.default_currency, row.status];

    if (hasServiceName) {
      columns.push("service_name");
      values.push(row.service_name);
    }
    if (hasBillingUnit) {
      columns.push("billing_unit");
      values.push(row.billing_unit);
    }
    if (hasPricingPolicy) {
      columns.push("pricing_policy");
      values.push(row.pricing_policy);
    }
    if (hasDefaultRate) {
      columns.push("default_rate");
      values.push(row.default_rate);
    }

    const placeholders = columns.map(() => "?").join(", ");
    const updates = columns
      .filter((column) => column !== "service_code")
      .map((column) => `${column}=VALUES(${column})`)
      .join(", ");

    await getPool().query(
      `INSERT INTO service_catalog (${columns.join(", ")})
       VALUES (${placeholders})
       ON DUPLICATE KEY UPDATE ${updates}`,
      values
    );
  }
}

async function upsertExchangeRate(adminUserId) {
  if (!(await hasTable("exchange_rates"))) return;

  const hasSource = await hasColumn("exchange_rates", "source");
  const hasLocked = await hasColumn("exchange_rates", "locked");
  const today = new Date().toISOString().slice(0, 10);

  const columns = ["rate_date", "base_currency", "quote_currency", "rate", "status", "entered_by"];
  const values = [today, "THB", "KRW", 39.1234, "active", adminUserId];
  if (hasSource) {
    columns.push("source");
    values.push("manual");
  }
  if (hasLocked) {
    columns.push("locked");
    values.push(0);
  }

  const placeholders = columns.map(() => "?").join(", ");
  const updates = ["rate=VALUES(rate)", "status=VALUES(status)", "entered_by=VALUES(entered_by)"];
  if (hasSource) updates.push("source=VALUES(source)");
  if (hasLocked) updates.push("locked=VALUES(locked)");

  await getPool().query(
    `INSERT INTO exchange_rates (${columns.join(", ")})
     VALUES (${placeholders})
     ON DUPLICATE KEY UPDATE ${updates.join(", ")}`,
    values
  );
}

async function upsertContractRate(clientId) {
  if (!(await hasTable("client_contract_rates"))) return;

  const today = new Date().toISOString().slice(0, 10);
  await getPool().query(
    `INSERT INTO client_contract_rates (client_id, service_code, custom_rate, currency, effective_date)
     VALUES (?, 'OUTBOUND_FEE', 3200, 'KRW', ?)
     ON DUPLICATE KEY UPDATE custom_rate = VALUES(custom_rate), currency = VALUES(currency)`,
    [clientId, today]
  );
}

async function insertBillingEvents(clientId) {
  if (!(await hasTable("billing_events"))) return;

  const hasWarehouseId = await hasColumn("billing_events", "warehouse_id");
  const month = new Date().toISOString().slice(0, 7);
  const d1 = `${month}-03`;
  const d2 = `${month}-05`;
  const d3 = `${month}-07`;

  const [existing] = await getPool().query(
    `SELECT COUNT(*) AS cnt
     FROM billing_events
     WHERE deleted_at IS NULL
       AND reference_id IN ('DEMO-SHP-001', 'DEMO-BOX-001', 'DEMO-OUT-001')`
  );
  if (Number(existing[0]?.cnt || 0) > 0) return;

  if (hasWarehouseId) {
    await getPool().query(
      `INSERT INTO billing_events
        (client_id, warehouse_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb, unit_price_krw, amount_krw)
       VALUES
        (?, NULL, 'TH_SHIPPING', 'SHIPPING', 'DEMO-SHP-001', ?, 1, 'THB_BASED', 120, 120, NULL, NULL),
        (?, NULL, 'TH_BOX', 'SHIPPING', 'DEMO-BOX-001', ?, 5, 'THB_BASED', 8, 40, NULL, NULL),
        (?, NULL, 'OUTBOUND_FEE', 'OUTBOUND', 'DEMO-OUT-001', ?, 3, 'KRW_FIXED', NULL, NULL, 3500, 10500)`,
      [clientId, d1, clientId, d2, clientId, d3]
    );
  } else {
    await getPool().query(
      `INSERT INTO billing_events
        (client_id, service_code, reference_type, reference_id, event_date, qty, pricing_policy, unit_price_thb, amount_thb, unit_price_krw, amount_krw)
       VALUES
        (?, 'TH_SHIPPING', 'SHIPPING', 'DEMO-SHP-001', ?, 1, 'THB_BASED', 120, 120, NULL, NULL),
        (?, 'TH_BOX', 'SHIPPING', 'DEMO-BOX-001', ?, 5, 'THB_BASED', 8, 40, NULL, NULL),
        (?, 'OUTBOUND_FEE', 'OUTBOUND', 'DEMO-OUT-001', ?, 3, 'KRW_FIXED', NULL, NULL, 3500, 10500)`,
      [clientId, d1, clientId, d2, clientId, d3]
    );
  }
}

async function insertInvoiceDraft(clientId, adminUserId) {
  if (!(await hasTable("invoices")) || !(await hasTable("invoice_items"))) return;

  const hasInvoiceMonth = await hasColumn("invoices", "invoice_month");
  const hasInvoiceDate = await hasColumn("invoices", "invoice_date");
  const hasFxRate = await hasColumn("invoices", "fx_rate_thbkrw");
  const hasSubtotal = await hasColumn("invoices", "subtotal_krw");
  const hasVat = await hasColumn("invoices", "vat_krw");
  const hasTotalKrw = await hasColumn("invoices", "total_krw");

  const meta = await getColumnMeta("invoices", "settlement_batch_id");
  const settlementNullable = String(meta?.is_nullable || "").toUpperCase() === "YES";
  if (!settlementNullable || !hasInvoiceMonth || !hasFxRate || !hasSubtotal || !hasVat || !hasTotalKrw) {
    return;
  }

  const month = new Date().toISOString().slice(0, 7);
  const [exists] = await getPool().query(
    `SELECT id
     FROM invoices
     WHERE client_id = ?
       AND invoice_month = ?
       AND deleted_at IS NULL
     ORDER BY id DESC
     LIMIT 1`,
    [clientId, month]
  );
  if (exists.length > 0) return;

  const issueDate = `${month}-10`;
  const subtotal = truncate100(10500 + 4695);
  const vat = truncate100(subtotal * 0.07);
  const total = truncate100(subtotal + vat);
  const yyyymm = month.replace("-", "");
  const invoiceNo = `KRW-${clientId}-${yyyymm}-0001`;

  const columns = [
    "settlement_batch_id",
    "client_id",
    "invoice_month",
    "invoice_no",
    "status",
    "issue_date",
    "due_date",
    "currency",
    "total_amount",
    "created_by",
    "fx_rate_thbkrw",
    "subtotal_krw",
    "vat_krw",
    "total_krw",
  ];
  const values = [null, clientId, month, invoiceNo, "draft", issueDate, issueDate, "KRW", total, adminUserId, 39.1234, subtotal, vat, total];
  if (hasInvoiceDate) {
    columns.splice(6, 0, "invoice_date");
    values.splice(6, 0, issueDate);
  }

  const [inserted] = await getPool().query(
    `INSERT INTO invoices (${columns.join(", ")})
     VALUES (${columns.map(() => "?").join(", ")})`,
    values
  );
  const invoiceId = Number(inserted.insertId);

  await getPool().query(
    `INSERT INTO invoice_items (invoice_id, service_code, description, qty, unit_price_krw, amount_krw)
     VALUES
      (?, 'OUTBOUND_FEE', 'Outbound Fee', 3, 3500, 10500),
      (?, 'TH_SHIPPING', 'TH Shipping', 1, 4600, 4600),
      (?, 'VAT_7', 'VAT 7%', 1, ?, ?)`,
    [invoiceId, invoiceId, invoiceId, vat, vat]
  );
}

async function main() {
  const clientId = await ensureClient();
  const adminUserId = await ensureAdminUser(clientId);

  await upsertServiceRates();
  await upsertExchangeRate(adminUserId);
  await upsertContractRate(clientId);
  await insertBillingEvents(clientId);
  await insertInvoiceDraft(clientId, adminUserId);

  console.log(`SEED_OK client_id=${clientId} admin_user_id=${adminUserId}`);
}

main()
  .catch((error) => {
    console.error(`SEED_FAILED ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPool().end();
    } catch (_error) {
      // ignore
    }
  });
