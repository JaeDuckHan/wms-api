const express = require("express");
const { getPool } = require("../db");

const router = express.Router();
const PALLET_CBM = 1.2;

function getTodayDate() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(input, defaultLabel = "today") {
  if (input == null || input === "") {
    return {
      ok: true,
      value: getTodayDate(),
      label: defaultLabel
    };
  }

  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return {
      ok: true,
      value: input,
      label: input
    };
  }

  return {
    ok: false,
    message: "Invalid date format. Use YYYY-MM-DD."
  };
}

function resolveDateRequired(input, fieldName) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return {
      ok: false,
      message: `Invalid ${fieldName} format. Use YYYY-MM-DD.`
    };
  }

  return {
    ok: true,
    value: input
  };
}

function resolveMonthRequired(input) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}$/.test(input)) {
    return {
      ok: false,
      message: "Invalid month format. Use YYYY-MM."
    };
  }

  return {
    ok: true,
    value: input
  };
}

function parseOptionalPositiveInt(value, fieldName) {
  if (value == null || value === "") {
    return { ok: true, value: null };
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { ok: false, message: `Invalid ${fieldName}. Use a positive integer.` };
  }

  return { ok: true, value: parsed };
}

function parseOptionalNonNegativeNumber(value, fieldName, defaultValue = 0) {
  if (value == null || value === "") {
    return { ok: true, value: defaultValue };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { ok: false, message: `Invalid ${fieldName}. Use a number >= 0.` };
  }

  return { ok: true, value: parsed };
}

function resolveFilters(query = {}, body = {}) {
  const warehouseIdResult = parseOptionalPositiveInt(query.warehouseId ?? body.warehouseId, "warehouseId");
  if (!warehouseIdResult.ok) {
    return warehouseIdResult;
  }

  const clientIdResult = parseOptionalPositiveInt(query.clientId ?? body.clientId, "clientId");
  if (!clientIdResult.ok) {
    return clientIdResult;
  }

  return {
    ok: true,
    value: {
      warehouseId: warehouseIdResult.value,
      clientId: clientIdResult.value
    }
  };
}

function appendSnapshotFilter(where, params, filters, alias = "ss") {
  let nextWhere = where;
  if (filters.warehouseId) {
    nextWhere += ` AND ${alias}.warehouse_id = ?`;
    params.push(filters.warehouseId);
  }
  if (filters.clientId) {
    nextWhere += ` AND ${alias}.client_id = ?`;
    params.push(filters.clientId);
  }
  return nextWhere;
}

function appendInventoryFilter(where, params, filters, alias = "sb") {
  let nextWhere = where;
  if (filters.warehouseId) {
    nextWhere += ` AND ${alias}.warehouse_id = ?`;
    params.push(filters.warehouseId);
  }
  if (filters.clientId) {
    nextWhere += ` AND ${alias}.client_id = ?`;
    params.push(filters.clientId);
  }
  return nextWhere;
}

function resolveGroupBy(input) {
  if (input == null || input === "") {
    return { ok: true, value: "day" };
  }

  const normalized = String(input).toLowerCase();
  if (!["day", "week", "month"].includes(normalized)) {
    return {
      ok: false,
      message: "Invalid groupBy. Use day, week, or month."
    };
  }

  return { ok: true, value: normalized };
}

function periodExpression(groupBy) {
  if (groupBy === "week") {
    return "CONCAT(YEAR(ss.snapshot_date), '-W', LPAD(WEEK(ss.snapshot_date, 1), 2, '0'))";
  }
  if (groupBy === "month") {
    return "DATE_FORMAT(ss.snapshot_date, '%Y-%m')";
  }
  return "DATE_FORMAT(ss.snapshot_date, '%Y-%m-%d')";
}

function getCapacityStatus(usagePctCbm) {
  if (usagePctCbm == null || usagePctCbm < 80) {
    return "ok";
  }
  if (usagePctCbm < 95) {
    return "warn";
  }
  return "critical";
}

async function upsertStorageSnapshots(snapshotDate, filters) {
  const pool = getPool();
  const params = [snapshotDate, PALLET_CBM];
  const where = appendInventoryFilter(
    " WHERE sb.deleted_at IS NULL AND p.deleted_at IS NULL AND sb.available_qty > 0",
    params,
    filters
  );

  await pool.query(
    `INSERT INTO storage_snapshots
      (warehouse_id, client_id, snapshot_date, total_cbm, total_pallet, total_sku)
     SELECT
      sb.warehouse_id,
      sb.client_id,
      ? AS snapshot_date,
      ROUND(SUM((sb.available_qty * COALESCE(p.volume_ml, 0)) / 1000000), 4) AS total_cbm,
      ROUND(SUM((sb.available_qty * COALESCE(p.volume_ml, 0)) / 1000000 / ?), 4) AS total_pallet,
      COUNT(DISTINCT sb.product_id) AS total_sku
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     ${where}
     GROUP BY sb.warehouse_id, sb.client_id
     ON DUPLICATE KEY UPDATE
      total_cbm = VALUES(total_cbm),
      total_pallet = VALUES(total_pallet),
      total_sku = VALUES(total_sku)`,
    params
  );
}

async function fetchMissingCbmAlerts(filters) {
  const pool = getPool();
  const params = [];
  const where = appendInventoryFilter(
    " WHERE sb.deleted_at IS NULL AND p.deleted_at IS NULL AND sb.available_qty > 0 AND (p.volume_ml IS NULL OR p.volume_ml <= 0)",
    params,
    filters
  );

  const [rows] = await pool.query(
    `SELECT
      sb.warehouse_id,
      sb.client_id,
      p.id AS product_id,
      p.sku_code,
      p.name_kr AS product_name,
      SUM(sb.available_qty) AS available_qty
     FROM stock_balances sb
     JOIN products p ON p.id = sb.product_id
     ${where}
     GROUP BY sb.warehouse_id, sb.client_id, p.id, p.sku_code, p.name_kr
     ORDER BY sb.warehouse_id ASC, sb.client_id ASC, p.id ASC`,
    params
  );

  return rows;
}

async function fetchStorageBreakdown(snapshotDate, filters) {
  const pool = getPool();
  const params = [snapshotDate];
  const where = appendSnapshotFilter(" WHERE ss.snapshot_date = ?", params, filters, "ss");

  const [rows] = await pool.query(
    `SELECT
      ss.warehouse_id,
      ss.client_id,
      ss.snapshot_date,
      ss.total_cbm,
      ss.total_pallet,
      ss.total_sku
     FROM storage_snapshots ss
     ${where}
     ORDER BY ss.warehouse_id ASC, ss.client_id ASC`,
    params
  );

  return rows;
}

async function generateSnapshots(req, res) {
  const dateResult = resolveDate(req.query.date || req.body?.date, getTodayDate());
  if (!dateResult.ok) {
    return res.status(400).json({ ok: false, message: dateResult.message });
  }

  const filtersResult = resolveFilters(req.query, req.body);
  if (!filtersResult.ok) {
    return res.status(400).json({ ok: false, message: filtersResult.message });
  }

  try {
    await upsertStorageSnapshots(dateResult.value, filtersResult.value);
    const missingCbmRows = await fetchMissingCbmAlerts(filtersResult.value);

    return res.json({
      ok: true,
      data: {
        snapshot_date: dateResult.value,
        filters: {
          warehouseId: filtersResult.value.warehouseId,
          clientId: filtersResult.value.clientId
        },
        generated: true,
        alerts: {
          missing_product_cbm_count: missingCbmRows.length,
          missing_product_cbm_items: missingCbmRows
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
}

async function getStorageDashboard(req, res) {
  const dateResult = resolveDate(req.query.date);
  if (!dateResult.ok) {
    return res.status(400).json({ ok: false, message: dateResult.message });
  }

  const filtersResult = resolveFilters(req.query);
  if (!filtersResult.ok) {
    return res.status(400).json({ ok: false, message: filtersResult.message });
  }

  try {
    const filters = filtersResult.value;
    const breakdown = await fetchStorageBreakdown(dateResult.value, filters);

    const totals = breakdown.reduce(
      (acc, row) => {
        acc.total_cbm += Number(row.total_cbm || 0);
        acc.total_pallet += Number(row.total_pallet || 0);
        acc.total_sku += Number(row.total_sku || 0);
        return acc;
      },
      { total_cbm: 0, total_pallet: 0, total_sku: 0 }
    );

    return res.json({
      ok: true,
      date: dateResult.label,
      filters: {
        warehouseId: filters.warehouseId,
        clientId: filters.clientId
      },
      totals: {
        total_cbm: Number(totals.total_cbm.toFixed(4)),
        total_pallet: Number(totals.total_pallet.toFixed(4)),
        total_sku: totals.total_sku
      },
      breakdown
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
}

async function getStorageTrend(req, res) {
  const fromResult = resolveDateRequired(req.query.from, "from");
  if (!fromResult.ok) {
    return res.status(400).json({ ok: false, message: fromResult.message });
  }

  const toResult = resolveDateRequired(req.query.to, "to");
  if (!toResult.ok) {
    return res.status(400).json({ ok: false, message: toResult.message });
  }

  const groupByResult = resolveGroupBy(req.query.groupBy);
  if (!groupByResult.ok) {
    return res.status(400).json({ ok: false, message: groupByResult.message });
  }

  const filtersResult = resolveFilters(req.query);
  if (!filtersResult.ok) {
    return res.status(400).json({ ok: false, message: filtersResult.message });
  }

  try {
    const filters = filtersResult.value;
    const groupBy = groupByResult.value;
    const pool = getPool();
    const params = [fromResult.value, toResult.value];
    const where = appendSnapshotFilter(
      " WHERE ss.snapshot_date BETWEEN ? AND ?",
      params,
      filters,
      "ss"
    );

    const [series] = await pool.query(
      `SELECT
        ${periodExpression(groupBy)} AS period,
        ROUND(SUM(ss.total_cbm), 4) AS total_cbm,
        ROUND(SUM(ss.total_pallet), 4) AS total_pallet,
        SUM(ss.total_sku) AS total_sku
       FROM storage_snapshots ss
       ${where}
       GROUP BY period
       ORDER BY MIN(ss.snapshot_date) ASC`,
      params
    );

    const totals = series.reduce(
      (acc, row) => {
        acc.total_cbm += Number(row.total_cbm || 0);
        acc.total_pallet += Number(row.total_pallet || 0);
        acc.total_sku += Number(row.total_sku || 0);
        return acc;
      },
      { total_cbm: 0, total_pallet: 0, total_sku: 0 }
    );

    return res.json({
      ok: true,
      from: fromResult.value,
      to: toResult.value,
      groupBy,
      filters: {
        warehouseId: filters.warehouseId,
        clientId: filters.clientId
      },
      totals: {
        total_cbm: Number(totals.total_cbm.toFixed(4)),
        total_pallet: Number(totals.total_pallet.toFixed(4)),
        total_sku: totals.total_sku
      },
      series
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
}

async function getStorageBillingPreview(req, res) {
  const monthResult = resolveMonthRequired(req.query.month);
  if (!monthResult.ok) {
    return res.status(400).json({ ok: false, message: monthResult.message });
  }

  const filtersResult = resolveFilters(req.query);
  if (!filtersResult.ok) {
    return res.status(400).json({ ok: false, message: filtersResult.message });
  }

  const rateCbmResult = parseOptionalNonNegativeNumber(req.query.rateCbm, "rateCbm", 0);
  if (!rateCbmResult.ok) {
    return res.status(400).json({ ok: false, message: rateCbmResult.message });
  }

  const ratePalletResult = parseOptionalNonNegativeNumber(req.query.ratePallet, "ratePallet", 0);
  if (!ratePalletResult.ok) {
    return res.status(400).json({ ok: false, message: ratePalletResult.message });
  }

  try {
    const filters = filtersResult.value;
    const month = monthResult.value;
    const monthStart = `${month}-01`;
    const pool = getPool();

    const params = [rateCbmResult.value, ratePalletResult.value, rateCbmResult.value, ratePalletResult.value, monthStart, monthStart];
    const where = appendSnapshotFilter(
      " WHERE ss.snapshot_date >= ? AND ss.snapshot_date < DATE_ADD(?, INTERVAL 1 MONTH)",
      params,
      filters,
      "ss"
    );

    const [lines] = await pool.query(
      `SELECT
        ss.warehouse_id,
        ss.client_id,
        COUNT(DISTINCT ss.snapshot_date) AS days_count,
        ROUND(SUM(ss.total_cbm) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0), 4) AS avg_cbm,
        ROUND(SUM(ss.total_pallet) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0), 4) AS avg_pallet,
        ROUND((SUM(ss.total_cbm) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0)) * ?, 4) AS amount_cbm,
        ROUND((SUM(ss.total_pallet) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0)) * ?, 4) AS amount_pallet,
        ROUND(
          ((SUM(ss.total_cbm) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0)) * ?)
          +
          ((SUM(ss.total_pallet) / NULLIF(COUNT(DISTINCT ss.snapshot_date), 0)) * ?),
          4
        ) AS amount_total
       FROM storage_snapshots ss
       ${where}
       GROUP BY ss.warehouse_id, ss.client_id
       ORDER BY ss.warehouse_id ASC, ss.client_id ASC`,
      params
    );

    const summary = lines.reduce(
      (acc, row) => {
        acc.amount_cbm += Number(row.amount_cbm || 0);
        acc.amount_pallet += Number(row.amount_pallet || 0);
        acc.amount_total += Number(row.amount_total || 0);
        return acc;
      },
      { amount_total: 0, amount_cbm: 0, amount_pallet: 0 }
    );

    return res.json({
      ok: true,
      month,
      rates: {
        rateCbm: rateCbmResult.value,
        ratePallet: ratePalletResult.value
      },
      filters: {
        warehouseId: filters.warehouseId,
        clientId: filters.clientId
      },
      summary: {
        amount_total: Number(summary.amount_total.toFixed(4)),
        amount_cbm: Number(summary.amount_cbm.toFixed(4)),
        amount_pallet: Number(summary.amount_pallet.toFixed(4))
      },
      lines
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
}

async function getStorageCapacity(req, res) {
  const dateResult = resolveDate(req.query.date);
  if (!dateResult.ok) {
    return res.status(400).json({ ok: false, message: dateResult.message });
  }

  const warehouseIdResult = parseOptionalPositiveInt(req.query.warehouseId, "warehouseId");
  if (!warehouseIdResult.ok) {
    return res.status(400).json({ ok: false, message: warehouseIdResult.message });
  }

  try {
    const pool = getPool();
    const params = [dateResult.value];
    let where = " WHERE w.deleted_at IS NULL";

    if (warehouseIdResult.value) {
      where += " AND w.id = ?";
      params.push(warehouseIdResult.value);
    }

    const [rows] = await pool.query(
      `SELECT
        w.id AS warehouse_id,
        COALESCE(used.used_cbm, 0) AS used_cbm,
        w.capacity_cbm,
        COALESCE(used.used_pallet, 0) AS used_pallet,
        w.capacity_pallet
       FROM warehouses w
       LEFT JOIN (
         SELECT
           ss.warehouse_id,
           ROUND(SUM(ss.total_cbm), 4) AS used_cbm,
           ROUND(SUM(ss.total_pallet), 4) AS used_pallet
         FROM storage_snapshots ss
         WHERE ss.snapshot_date = ?
         GROUP BY ss.warehouse_id
       ) used ON used.warehouse_id = w.id
       ${where}
       ORDER BY w.id ASC`,
      params
    );

    const warehouses = rows.map((row) => {
      const usedCbm = Number(row.used_cbm || 0);
      const usedPallet = Number(row.used_pallet || 0);
      const capacityCbm = row.capacity_cbm == null ? null : Number(row.capacity_cbm);
      const capacityPallet = row.capacity_pallet == null ? null : Number(row.capacity_pallet);
      const usagePctCbm = capacityCbm && capacityCbm > 0 ? Number(((usedCbm / capacityCbm) * 100).toFixed(2)) : null;
      const usagePctPallet = capacityPallet && capacityPallet > 0 ? Number(((usedPallet / capacityPallet) * 100).toFixed(2)) : null;
      const status = getCapacityStatus(usagePctCbm);

      return {
        warehouse_id: row.warehouse_id,
        used_cbm: Number(usedCbm.toFixed(4)),
        capacity_cbm: capacityCbm,
        usage_pct_cbm: usagePctCbm,
        status,
        used_pallet: Number(usedPallet.toFixed(4)),
        capacity_pallet: capacityPallet,
        usage_pct_pallet: usagePctPallet
      };
    });

    return res.json({
      ok: true,
      date: dateResult.label,
      warehouses,
      alerts: warehouses.filter((item) => item.status !== "ok")
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
}

router.post("/storage/snapshots/generate", generateSnapshots);
router.get("/storage", getStorageDashboard);
router.get("/storage/trend", getStorageTrend);
router.get("/storage/billing/preview", getStorageBillingPreview);
router.get("/storage/capacity", getStorageCapacity);

module.exports = {
  router,
  upsertStorageSnapshots
};
