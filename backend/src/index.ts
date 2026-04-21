/// <reference types="bun-types" />
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import postgres from "postgres";
import path from "path";
import { createHash, randomBytes } from "crypto";

const app = new Hono();
app.use("/*", cors());

// Conexión a PostgreSQL
const connectionString = process.env.DATABASE_URL || "postgresql://postgres:password@localhost:5432/tienda";
const sql = postgres(connectionString);

// ===== HELPERS DE AUTH =====
function hashPassword(password: string): string {
  return createHash("sha256").update(password + "mcba_salt_2024").digest("hex");
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

async function getUserFromToken(token: string | undefined) {
  if (!token) return null;
  const sessions = await sql`
    SELECT u.id, u.username, u.email, u.role_id, r.name as role_name
    FROM user_sessions s
    JOIN users u ON s.user_id = u.id
    JOIN roles r ON u.role_id = r.id
    WHERE s.token = ${token} AND s.expires_at > NOW()
  `;
  return sessions.length > 0 ? sessions[0] : null;
}

async function getUserPermissions(roleId: number) {
  const perms = await sql`
    SELECT resource, action FROM permissions WHERE role_id = ${roleId}
  `;
  return perms;
}

async function hasPermission(roleId: number, resource: string, action: string): Promise<boolean> {
  const perms = await sql`
    SELECT id FROM permissions
    WHERE role_id = ${roleId}
      AND (resource = ${resource} OR resource = 'all')
      AND (action = ${action} OR action = 'all')
  `;
  return perms.length > 0;
}

// ===== MIDDLEWARE =====
async function authMiddleware(c: any, next: any) {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.replace("Bearer ", "") || c.req.header("X-Session-Token");
  const user = await getUserFromToken(token);
  if (!user) {
    return c.json({ error: "No autorizado" }, 401);
  }
  c.set("user", user);
  await next();
}

async function adminMiddleware(c: any, next: any) {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.replace("Bearer ", "") || c.req.header("X-Session-Token");
  const user = await getUserFromToken(token);
  if (!user) {
    return c.json({ error: "No autorizado" }, 401);
  }
  if (user.role_name !== "Admin") {
    return c.json({ error: "Acceso denegado: se requiere rol Admin" }, 403);
  }
  c.set("user", user);
  await next();
}

// Servir archivos estáticos del frontend
app.use("/*", serveStatic({ 
  root: path.join(import.meta.dir, '../../frontend'),
  rewriteRequestPath: (reqPath) => {
    if (reqPath === '/') return '/index.html';
    return reqPath.startsWith('/api') ? reqPath : `/index.html`;
  }
}));

// ===== INICIALIZAR TABLAS =====
try {
  await sql`
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      price DECIMAL(10, 2) NOT NULL,
      stock_quantity INT DEFAULT 0,
      image_url TEXT,
      sku TEXT UNIQUE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      movement_type VARCHAR(10) NOT NULL,
      quantity INT NOT NULL,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_amount DECIMAL(10, 2) NOT NULL,
      discount_amount DECIMAL(10, 2) DEFAULT 0,
      final_amount DECIMAL(10, 2) NOT NULL,
      status VARCHAR(20) DEFAULT 'COMPLETED'
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INT NOT NULL REFERENCES sales(id),
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      subtotal DECIMAL(10, 2) NOT NULL
    )
  `;

  // RBAC Tables
  await sql`
    CREATE TABLE IF NOT EXISTS roles (
      id SERIAL PRIMARY KEY,
      name VARCHAR(50) UNIQUE NOT NULL,
      description TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      email VARCHAR(100) UNIQUE NOT NULL,
      role_id INT REFERENCES roles(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS permissions (
      id SERIAL PRIMARY KEY,
      role_id INT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      resource VARCHAR(50) NOT NULL,
      action VARCHAR(50) NOT NULL,
      UNIQUE(role_id, resource, action)
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS user_sessions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  console.log("✓ Tablas creadas correctamente");

  // ===== ROLES Y PERMISOS POR DEFECTO =====
  const existingRoles = await sql`SELECT id FROM roles LIMIT 1`;
  if (existingRoles.length === 0) {
    // Crear roles
    const adminRole = await sql`
      INSERT INTO roles (name, description) VALUES ('Admin', 'Acceso completo a todo el sistema') RETURNING id
    `;
    const managerRole = await sql`
      INSERT INTO roles (name, description) VALUES ('Manager', 'Acceso a Inventario, Ventas y Reportes') RETURNING id
    `;
    const sellerRole = await sql`
      INSERT INTO roles (name, description) VALUES ('Seller', 'Acceso a Tienda y Ventas') RETURNING id
    `;
    const viewerRole = await sql`
      INSERT INTO roles (name, description) VALUES ('Viewer', 'Acceso de solo lectura a Tienda') RETURNING id
    `;

    const adminId = adminRole[0].id;
    const managerId = managerRole[0].id;
    const sellerId = sellerRole[0].id;
    const viewerId = viewerRole[0].id;

    // Permisos Admin: acceso total
    await sql`INSERT INTO permissions (role_id, resource, action) VALUES (${adminId}, 'all', 'all')`;

    // Permisos Manager
    for (const resource of ['inventario', 'ventas', 'reportes']) {
      for (const action of ['read', 'create', 'update', 'delete']) {
        await sql`INSERT INTO permissions (role_id, resource, action) VALUES (${managerId}, ${resource}, ${action})`;
      }
    }

    // Permisos Seller
    for (const resource of ['tienda', 'ventas']) {
      for (const action of ['read', 'create', 'update']) {
        await sql`INSERT INTO permissions (role_id, resource, action) VALUES (${sellerId}, ${resource}, ${action})`;
      }
    }

    // Permisos Viewer
    await sql`INSERT INTO permissions (role_id, resource, action) VALUES (${viewerId}, 'tienda', 'read')`;

    // Crear usuario admin por defecto
    const adminPasswordHash = hashPassword("admin123");
    await sql`
      INSERT INTO users (username, password_hash, email, role_id)
      VALUES ('admin', ${adminPasswordHash}, 'admin@mejorcompra.ba', ${adminId})
    `;

    console.log("✓ Roles, permisos y usuario admin creados");
    console.log("  → Usuario: admin | Contraseña: admin123");
  }
} catch (error) {
  console.error("Error creando tablas:", error);
}

// ===== PÁGINA PRINCIPAL =====
app.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
app.get("/", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tienda Virtual - Mejor Compra BA</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #f5f5f5; }

    /* ── Auth overlay ── */
    #authOverlay {
      position: fixed; inset: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      display: flex; align-items: center; justify-content: center; z-index: 1000;
    }
    .auth-box {
      background: white; border-radius: 12px; padding: 40px; width: 380px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    .auth-box h2 { text-align: center; color: #333; margin-bottom: 8px; font-size: 24px; }
    .auth-box p.subtitle { text-align: center; color: #888; margin-bottom: 28px; font-size: 14px; }
    .auth-tabs { display: flex; margin-bottom: 24px; border-bottom: 2px solid #eee; }
    .auth-tab {
      flex: 1; padding: 10px; text-align: center; cursor: pointer;
      color: #888; font-weight: 600; border-bottom: 3px solid transparent; margin-bottom: -2px;
    }
    .auth-tab.active { color: #667eea; border-bottom-color: #667eea; }

    /* ── Header ── */
    header {
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white; padding: 16px 24px;
      display: flex; align-items: center; justify-content: space-between;
    }
    header h1 { font-size: 20px; }
    header p { font-size: 13px; opacity: .8; }
    .user-menu { position: relative; }
    .user-btn {
      background: rgba(255,255,255,.2); border: none; color: white;
      padding: 8px 16px; border-radius: 20px; cursor: pointer; font-size: 14px;
      display: flex; align-items: center; gap: 8px;
    }
    .user-btn:hover { background: rgba(255,255,255,.3); }
    .user-dropdown {
      display: none; position: absolute; right: 0; top: calc(100% + 8px);
      background: white; border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.15);
      min-width: 200px; overflow: hidden; z-index: 100;
    }
    .user-dropdown.open { display: block; }
    .user-dropdown-header { padding: 14px 16px; background: #f8f8f8; border-bottom: 1px solid #eee; }
    .user-dropdown-header strong { display: block; color: #333; }
    .user-dropdown-header span { font-size: 12px; color: #888; }
    .user-dropdown a {
      display: block; padding: 12px 16px; color: #333; text-decoration: none;
      font-size: 14px; cursor: pointer;
    }
    .user-dropdown a:hover { background: #f5f5f5; }
    .user-dropdown a.danger { color: #e53935; }

    /* ── Nav ── */
    nav { background: #333; padding: 0 24px; display: flex; gap: 4px; align-items: center; }
    nav a {
      color: #ccc; text-decoration: none; padding: 14px 18px;
      cursor: pointer; font-size: 14px; border-bottom: 3px solid transparent;
      transition: all .2s;
    }
    nav a:hover { color: white; background: rgba(255,255,255,.05); }
    nav a.active { color: white; border-bottom-color: #667eea; }
    nav a.hidden { display: none; }
    .nav-admin { margin-left: auto; }
    nav a.nav-admin { color: #ffd54f; }
    nav a.nav-admin:hover { color: #fff; background: rgba(255,213,79,.1); }

    /* ── Layout ── */
    .container { max-width: 1200px; margin: 24px auto; padding: 0 20px; }
    .section { display: none; }
    .section.active { display: block; }

    /* ── Cards & grids ── */
    .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
    .product-card { background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.08); transition: transform .2s, box-shadow .2s; }
    .product-card:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(0,0,0,.12); }
    .product-image { width: 100%; height: 180px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; font-size: 56px; }
    .product-image img { width: 100%; height: 100%; object-fit: cover; }
    .product-info { padding: 14px; }
    .product-name { font-weight: 600; font-size: 15px; margin-bottom: 4px; color: #222; }
    .product-price { color: #667eea; font-size: 18px; font-weight: 700; margin: 8px 0; }
    .product-stock { color: #777; font-size: 13px; }

    /* ── Forms ── */
    .card { background: white; border-radius: 10px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    .form-group { margin-bottom: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 6px; font-size: 13px; color: #555; }
    input, textarea, select {
      width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px;
      font-size: 14px; transition: border-color .2s;
    }
    input:focus, textarea:focus, select:focus { outline: none; border-color: #667eea; }
    button {
      background: #667eea; color: white; border: none; padding: 10px 18px;
      border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 600;
      transition: background .2s;
    }
    button:hover { background: #5a6fd6; }
    button.danger { background: #e53935; }
    button.danger:hover { background: #c62828; }
    button.secondary { background: #78909c; }
    button.secondary:hover { background: #607d8b; }
    button.success-btn { background: #43a047; }
    button.success-btn:hover { background: #388e3c; }

    /* ── Alerts ── */
    .success { color: #2e7d32; padding: 10px 14px; background: #e8f5e9; border-radius: 6px; margin: 10px 0; border-left: 4px solid #43a047; }
    .error { color: #c62828; padding: 10px 14px; background: #ffebee; border-radius: 6px; margin: 10px 0; border-left: 4px solid #e53935; }

    /* ── Tables ── */
    table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,.06); }
    th, td { padding: 12px 16px; text-align: left; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    th { background: #667eea; color: white; font-weight: 600; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #fafafa; }

    /* ── Cart ── */
    .cart-item {
      background: white; padding: 14px 16px; margin: 8px 0; border-radius: 8px;
      display: flex; justify-content: space-between; align-items: center;
      box-shadow: 0 1px 4px rgba(0,0,0,.06);
    }

    /* ── Admin panel ── */
    .admin-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 20px; margin-bottom: 28px; }
    .stat-card {
      background: white; border-radius: 10px; padding: 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,.06); display: flex; align-items: center; gap: 16px;
    }
    .stat-icon { font-size: 36px; }
    .stat-info strong { display: block; font-size: 22px; color: #333; }
    .stat-info span { font-size: 13px; color: #888; }
    .badge {
      display: inline-block; padding: 3px 10px; border-radius: 12px;
      font-size: 12px; font-weight: 600;
    }
    .badge-admin { background: #fce4ec; color: #c2185b; }
    .badge-manager { background: #e3f2fd; color: #1565c0; }
    .badge-seller { background: #e8f5e9; color: #2e7d32; }
    .badge-viewer { background: #fff3e0; color: #e65100; }
    .badge-default { background: #f3e5f5; color: #6a1b9a; }
    .perm-tag {
      display: inline-block; padding: 2px 8px; border-radius: 4px;
      font-size: 11px; background: #e8eaf6; color: #3949ab; margin: 2px;
    }
    .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 2px solid #eee; }
    .tab-btn {
      padding: 10px 20px; cursor: pointer; border: none; background: none;
      color: #888; font-weight: 600; border-bottom: 3px solid transparent; margin-bottom: -2px;
    }
    .tab-btn.active { color: #667eea; border-bottom-color: #667eea; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .three-col { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .two-col, .three-col { grid-template-columns: 1fr; } }
  </style>
</head>
<body>

<!-- ══════════════════════════════════════════════════════════
     AUTH OVERLAY
══════════════════════════════════════════════════════════ -->
<div id="authOverlay">
  <div class="auth-box">
    <h2>🛍️ Mejor Compra BA</h2>
    <p class="subtitle">Sistema de Gestión de Tienda</p>
    <div class="auth-tabs">
      <div class="auth-tab active" onclick="switchAuthTab('login')">Iniciar Sesión</div>
      <div class="auth-tab" onclick="switchAuthTab('register')">Registrarse</div>
    </div>

    <!-- Login -->
    <div id="loginForm">
      <div class="form-group">
        <label>Usuario</label>
        <input type="text" id="loginUsername" placeholder="Nombre de usuario" autocomplete="username">
      </div>
      <div class="form-group">
        <label>Contraseña</label>
        <input type="password" id="loginPassword" placeholder="Contraseña" autocomplete="current-password">
      </div>
      <button onclick="doLogin()" style="width:100%;padding:12px;font-size:15px;">Ingresar</button>
      <div id="loginMsg"></div>
    </div>

    <!-- Register -->
    <div id="registerForm" style="display:none;">
      <div class="form-group">
        <label>Usuario</label>
        <input type="text" id="regUsername" placeholder="Nombre de usuario">
      </div>
      <div class="form-group">
        <label>Email</label>
        <input type="email" id="regEmail" placeholder="correo@ejemplo.com">
      </div>
      <div class="form-group">
        <label>Contraseña</label>
        <input type="password" id="regPassword" placeholder="Mínimo 6 caracteres">
      </div>
      <button onclick="doRegister()" style="width:100%;padding:12px;font-size:15px;">Crear Cuenta</button>
      <div id="registerMsg"></div>
    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════════════════════
     MAIN APP
══════════════════════════════════════════════════════════ -->
<div id="mainApp" style="display:none;">
  <header>
    <div>
      <h1>🛍️ Tienda Virtual - Mejor Compra BA</h1>
      <p>Gestión de Inventario y Ventas</p>
    </div>
    <div class="user-menu">
      <button class="user-btn" onclick="toggleUserMenu()">
        <span>👤</span>
        <span id="headerUsername">Usuario</span>
        <span>▾</span>
      </button>
      <div class="user-dropdown" id="userDropdown">
        <div class="user-dropdown-header">
          <strong id="dropdownName">-</strong>
          <span id="dropdownRole">-</span>
        </div>
        <a onclick="showSection('perfil')">👤 Mi Perfil</a>
        <a onclick="doLogout()" class="danger">🚪 Cerrar Sesión</a>
      </div>
    </div>
  </header>

  <nav id="mainNav">
    <a id="nav-tienda"    onclick="showSection('tienda')">🏪 Tienda</a>
    <a id="nav-inventario" onclick="showSection('inventario')">📦 Inventario</a>
    <a id="nav-ventas"   onclick="showSection('ventas')">💳 Ventas</a>
    <a id="nav-reportes" onclick="showSection('reportes')">📊 Reportes</a>
    <a id="nav-admin"    onclick="showSection('admin')" class="nav-admin hidden">⚙️ Admin</a>
  </nav>

  <div class="container">

    <!-- ── TIENDA ── -->
    <div id="tienda" class="section active">
      <h2 style="margin-bottom:20px;">Catálogo de Productos</h2>
      <div id="productsList" class="products-grid"></div>
    </div>

    <!-- ── INVENTARIO ── -->
    <div id="inventario" class="section">
      <h2 style="margin-bottom:20px;">Gestión de Inventario</h2>
      <div class="two-col">
        <div class="card">
          <h3 style="margin-bottom:16px;">Crear Producto</h3>
          <div class="form-group"><label>Nombre</label><input type="text" id="productName" placeholder="Nombre del producto"></div>
          <div class="form-group"><label>Descripción</label><textarea id="productDesc" placeholder="Descripción" rows="2"></textarea></div>
          <div class="form-group"><label>Precio</label><input type="number" id="productPrice" placeholder="0.00" step="0.01"></div>
          <div class="form-group"><label>SKU</label><input type="text" id="productSku" placeholder="SKU único"></div>
          <div class="form-group"><label>URL Imagen</label><input type="text" id="productImage" placeholder="https://..."></div>
          <button onclick="createProduct()">Crear Producto</button>
          <div id="createMsg"></div>
        </div>
        <div class="card">
          <h3 style="margin-bottom:16px;">Movimiento de Stock</h3>
          <div class="form-group"><label>Producto</label><select id="productSelect"></select></div>
          <div class="form-group"><label>Cantidad</label><input type="number" id="movementQty" placeholder="0" min="1"></div>
          <div class="form-group"><label>Razón</label><input type="text" id="movementReason" placeholder="Compra, devolución, etc."></div>
          <div style="display:flex;gap:10px;">
            <button onclick="addStock()" class="success-btn">➕ Entrada</button>
            <button onclick="removeStock()" class="danger">➖ Salida</button>
          </div>
          <div id="movementMsg"></div>
        </div>
      </div>
      <h3 style="margin:28px 0 12px;">Productos en Inventario</h3>
      <div id="inventoryList"></div>
    </div>

    <!-- ── VENTAS ── -->
    <div id="ventas" class="section">
      <h2 style="margin-bottom:20px;">Módulo de Ventas</h2>
      <div class="two-col">
        <div class="card">
          <h3 style="margin-bottom:16px;">Carrito de Compras</h3>
          <div class="form-group"><label>Seleccionar Producto</label><select id="saleProductSelect"></select></div>
          <div class="form-group"><label>Cantidad</label><input type="number" id="saleQty" placeholder="1" min="1" value="1"></div>
          <button onclick="addToCart()">Agregar al Carrito</button>
          <div id="cartItems" style="margin-top:16px;"></div>
        </div>
        <div class="card">
          <h3 style="margin-bottom:16px;">Resumen de Venta</h3>
          <div style="margin:16px 0;">
            <p style="margin-bottom:8px;">Subtotal: <strong id="subtotal">$0.00</strong></p>
            <div class="form-group">
              <label>Descuento (%)</label>
              <input type="number" id="discountPct" placeholder="0" min="0" max="100" value="0" oninput="updateTotal()">
            </div>
            <p style="margin-bottom:8px;">Descuento: <strong id="discountAmount">$0.00</strong></p>
            <p style="font-size:20px;color:#667eea;">Total: <strong id="totalAmount">$0.00</strong></p>
          </div>
          <button onclick="completeSale()" style="width:100%;padding:14px;font-size:16px;">Completar Venta</button>
          <div id="saleMsg"></div>
        </div>
      </div>
    </div>

    <!-- ── REPORTES ── -->
    <div id="reportes" class="section">
      <h2 style="margin-bottom:20px;">Reportes</h2>
      <div class="two-col">
        <div class="card">
          <h3 style="margin-bottom:12px;">Productos Más Vendidos</h3>
          <button onclick="loadTopProducts()">Cargar Reporte</button>
          <div id="topProductsReport" style="margin-top:16px;"></div>
        </div>
        <div class="card">
          <h3 style="margin-bottom:12px;">Historial de Ventas</h3>
          <button onclick="loadSalesHistory()">Cargar Historial</button>
          <div id="salesHistoryReport" style="margin-top:16px;"></div>
        </div>
      </div>
    </div>

    <!-- ── PERFIL ── -->
    <div id="perfil" class="section">
      <h2 style="margin-bottom:20px;">Mi Perfil</h2>
      <div style="max-width:480px;">
        <div class="card">
          <div id="profileInfo"></div>
          <hr style="margin:20px 0;border:none;border-top:1px solid #eee;">
          <h3 style="margin-bottom:16px;">Cambiar Contraseña</h3>
          <div class="form-group"><label>Contraseña Actual</label><input type="password" id="currentPwd" placeholder="Contraseña actual"></div>
          <div class="form-group"><label>Nueva Contraseña</label><input type="password" id="newPwd" placeholder="Nueva contraseña"></div>
          <div class="form-group"><label>Confirmar Nueva</label><input type="password" id="confirmPwd" placeholder="Confirmar contraseña"></div>
          <button onclick="changePassword()">Actualizar Contraseña</button>
          <div id="pwdMsg"></div>
        </div>
      </div>
    </div>

    <!-- ── ADMIN ── -->
    <div id="admin" class="section">
      <h2 style="margin-bottom:20px;">⚙️ Panel de Administración</h2>

      <!-- Stats -->
      <div class="admin-grid" id="adminStats"></div>

      <!-- Tabs -->
      <div class="tabs">
        <button class="tab-btn active" onclick="switchAdminTab('users')">👥 Usuarios</button>
        <button class="tab-btn" onclick="switchAdminTab('roles')">🎭 Roles</button>
        <button class="tab-btn" onclick="switchAdminTab('permissions')">🔑 Permisos</button>
      </div>

      <!-- Users tab -->
      <div id="tab-users" class="tab-content active">
        <div class="two-col" style="margin-bottom:20px;">
          <div class="card">
            <h3 style="margin-bottom:16px;">Usuarios del Sistema</h3>
            <div id="usersList"></div>
          </div>
          <div class="card">
            <h3 style="margin-bottom:16px;">Cambiar Rol de Usuario</h3>
            <div class="form-group"><label>Usuario</label><select id="changeRoleUser"></select></div>
            <div class="form-group"><label>Nuevo Rol</label><select id="changeRoleSelect"></select></div>
            <button onclick="changeUserRole()">Actualizar Rol</button>
            <div id="changeRoleMsg"></div>
          </div>
        </div>
      </div>

      <!-- Roles tab -->
      <div id="tab-roles" class="tab-content">
        <div class="two-col" style="margin-bottom:20px;">
          <div class="card">
            <h3 style="margin-bottom:16px;">Roles Existentes</h3>
            <div id="rolesList"></div>
          </div>
          <div class="card">
            <h3 style="margin-bottom:16px;">Crear Nuevo Rol</h3>
            <div class="form-group"><label>Nombre del Rol</label><input type="text" id="newRoleName" placeholder="Ej: Supervisor"></div>
            <div class="form-group"><label>Descripción</label><textarea id="newRoleDesc" placeholder="Descripción del rol" rows="3"></textarea></div>
            <button onclick="createRole()">Crear Rol</button>
            <div id="createRoleMsg"></div>
          </div>
        </div>
      </div>

      <!-- Permissions tab -->
      <div id="tab-permissions" class="tab-content">
        <div class="two-col" style="margin-bottom:20px;">
          <div class="card">
            <h3 style="margin-bottom:16px;">Permisos por Rol</h3>
            <div class="form-group">
              <label>Filtrar por Rol</label>
              <select id="permFilterRole" onchange="loadPermissions()"></select>
            </div>
            <div id="permissionsList"></div>
          </div>
          <div class="card">
            <h3 style="margin-bottom:16px;">Asignar Permiso</h3>
            <div class="form-group"><label>Rol</label><select id="permRoleSelect"></select></div>
            <div class="form-group">
              <label>Recurso</label>
              <select id="permResource">
                <option value="tienda">tienda</option>
                <option value="inventario">inventario</option>
                <option value="ventas">ventas</option>
                <option value="reportes">reportes</option>
                <option value="admin">admin</option>
                <option value="all">all (todo)</option>
              </select>
            </div>
            <div class="form-group">
              <label>Acción</label>
              <select id="permAction">
                <option value="read">read</option>
                <option value="create">create</option>
                <option value="update">update</option>
                <option value="delete">delete</option>
                <option value="all">all (todo)</option>
              </select>
            </div>
            <button onclick="assignPermission()">Asignar Permiso</button>
            <div id="assignPermMsg"></div>
          </div>
        </div>
      </div>

    </div><!-- /admin -->
  </div><!-- /container -->
</div><!-- /mainApp -->

<script>
  const API_URL = window.location.origin;
  let cart = [];
  let currentUser = null;
  let userPermissions = [];
  let sessionToken = localStorage.getItem('mcba_token');

  // ══════════════════════════════════════════════
  // AUTH
  // ══════════════════════════════════════════════
  function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach((t, i) => {
      t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'));
    });
    document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  }

  async function doLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!username || !password) {
      document.getElementById('loginMsg').innerHTML = '<div class="error">Completa todos los campos</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok) {
        sessionToken = data.token;
        localStorage.setItem('mcba_token', sessionToken);
        await initApp();
      } else {
        document.getElementById('loginMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('loginMsg').innerHTML = '<div class="error">Error de conexión</div>';
    }
  }

  async function doRegister() {
    const username = document.getElementById('regUsername').value.trim();
    const email = document.getElementById('regEmail').value.trim();
    const password = document.getElementById('regPassword').value;
    if (!username || !email || !password) {
      document.getElementById('registerMsg').innerHTML = '<div class="error">Completa todos los campos</div>';
      return;
    }
    if (password.length < 6) {
      document.getElementById('registerMsg').innerHTML = '<div class="error">La contraseña debe tener al menos 6 caracteres</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, email, password })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('registerMsg').innerHTML = '<div class="success">✓ Cuenta creada. Ahora inicia sesión.</div>';
        setTimeout(() => switchAuthTab('login'), 1500);
      } else {
        document.getElementById('registerMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('registerMsg').innerHTML = '<div class="error">Error de conexión</div>';
    }
  }

  async function doLogout() {
    try {
      await fetch(API_URL + '/api/auth/logout', {
        method: 'POST',
        headers: { 'X-Session-Token': sessionToken }
      });
    } catch (_) {}
    localStorage.removeItem('mcba_token');
    sessionToken = null;
    currentUser = null;
    userPermissions = [];
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('authOverlay').style.display = 'flex';
    document.getElementById('loginUsername').value = '';
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginMsg').innerHTML = '';
  }

  function toggleUserMenu() {
    document.getElementById('userDropdown').classList.toggle('open');
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-menu')) {
      document.getElementById('userDropdown')?.classList.remove('open');
    }
  });

  // ══════════════════════════════════════════════
  // APP INIT
  // ══════════════════════════════════════════════
  async function initApp() {
    if (!sessionToken) return;
    try {
      const res = await fetch(API_URL + '/api/auth/me', {
        headers: { 'X-Session-Token': sessionToken }
      });
      if (!res.ok) {
        localStorage.removeItem('mcba_token');
        return;
      }
      const data = await res.json();
      currentUser = data.user;
      userPermissions = data.permissions;

      // Update UI
      document.getElementById('headerUsername').textContent = currentUser.username;
      document.getElementById('dropdownName').textContent = currentUser.username;
      document.getElementById('dropdownRole').textContent = currentUser.role_name;

      // Show/hide nav items
      applyNavPermissions();

      document.getElementById('authOverlay').style.display = 'none';
      document.getElementById('mainApp').style.display = 'block';

      // Navigate to first allowed section
      const firstAllowed = getFirstAllowedSection();
      showSection(firstAllowed);
    } catch (e) {
      console.error('initApp error', e);
    }
  }

  function canAccess(resource) {
    if (!currentUser) return false;
    return userPermissions.some(p =>
      (p.resource === resource || p.resource === 'all') &&
      (p.action === 'read' || p.action === 'all')
    );
  }

  function canWrite(resource) {
    if (!currentUser) return false;
    return userPermissions.some(p =>
      (p.resource === resource || p.resource === 'all') &&
      (p.action === 'create' || p.action === 'update' || p.action === 'all')
    );
  }

  function isAdmin() {
    return currentUser?.role_name === 'Admin';
  }

  function applyNavPermissions() {
    const navMap = {
      'nav-tienda': 'tienda',
      'nav-inventario': 'inventario',
      'nav-ventas': 'ventas',
      'nav-reportes': 'reportes'
    };
    for (const [navId, resource] of Object.entries(navMap)) {
      const el = document.getElementById(navId);
      if (el) el.classList.toggle('hidden', !canAccess(resource));
    }
    const adminNav = document.getElementById('nav-admin');
    if (adminNav) adminNav.classList.toggle('hidden', !isAdmin());
  }

  function getFirstAllowedSection() {
    const sections = ['tienda', 'inventario', 'ventas', 'reportes'];
    for (const s of sections) {
      if (canAccess(s)) return s;
    }
    if (isAdmin()) return 'admin';
    return 'perfil';
  }

  // ══════════════════════════════════════════════
  // NAVIGATION
  // ══════════════════════════════════════════════
  function showSection(sectionId) {
    // Permission check for non-admin sections
    const protectedSections = { tienda: 'tienda', inventario: 'inventario', ventas: 'ventas', reportes: 'reportes' };
    if (protectedSections[sectionId] && !canAccess(protectedSections[sectionId])) {
      alert('No tienes permiso para acceder a esta sección.');
      return;
    }
    if (sectionId === 'admin' && !isAdmin()) {
      alert('Acceso denegado.');
      return;
    }

    document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
    document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
    const section = document.getElementById(sectionId);
    if (section) section.classList.add('active');
    const navEl = document.getElementById('nav-' + sectionId);
    if (navEl) navEl.classList.add('active');

    if (sectionId === 'tienda') loadProducts();
    if (sectionId === 'inventario') { loadProducts(); loadInventory(); }
    if (sectionId === 'ventas') { loadProducts(); loadProductsForSale(); }
    if (sectionId === 'admin') loadAdminPanel();
    if (sectionId === 'perfil') loadProfile();
  }

  // ══════════════════════════════════════════════
  // TIENDA
  // ══════════════════════════════════════════════
  async function loadProducts() {
    try {
      const res = await fetch(API_URL + '/api/products', { headers: { 'X-Session-Token': sessionToken } });
      const products = await res.json();
      const html = products.map(p => \`
        <div class="product-card">
          <div class="product-image">\${p.image_url ? \`<img src="\${p.image_url}" alt="\${p.name}">\` : '📦'}</div>
          <div class="product-info">
            <div class="product-name">\${p.name}</div>
            <div class="product-price">$\${parseFloat(p.price).toFixed(2)}</div>
            <div class="product-stock">Stock: \${p.stock_quantity}</div>
          </div>
        </div>
      \`).join('');
      const el = document.getElementById('productsList');
      if (el) el.innerHTML = html || '<p style="color:#888;padding:20px;">No hay productos disponibles.</p>';
    } catch (e) { console.error(e); }
  }

  // ══════════════════════════════════════════════
  // INVENTARIO
  // ══════════════════════════════════════════════
  async function loadInventory() {
    try {
      const res = await fetch(API_URL + '/api/products', { headers: { 'X-Session-Token': sessionToken } });
      const products = await res.json();
      const html = \`<table><tr><th>Producto</th><th>Precio</th><th>Stock</th><th>SKU</th></tr>\${products.map(p => \`<tr><td>\${p.name}</td><td>$\${parseFloat(p.price).toFixed(2)}</td><td>\${p.stock_quantity}</td><td>\${p.sku || '-'}</td></tr>\`).join('')}</table>\`;
      document.getElementById('inventoryList').innerHTML = html;
      const options = products.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
      document.getElementById('productSelect').innerHTML = '<option value="">Seleccionar...</option>' + options;
    } catch (e) { console.error(e); }
  }

  async function createProduct() {
    const name = document.getElementById('productName').value;
    const description = document.getElementById('productDesc').value;
    const price = document.getElementById('productPrice').value;
    const sku = document.getElementById('productSku').value;
    const image_url = document.getElementById('productImage').value;
    if (!name || !price) {
      document.getElementById('createMsg').innerHTML = '<div class="error">Nombre y precio requeridos</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ name, description, price: parseFloat(price), sku, image_url })
      });
      if (res.ok) {
        document.getElementById('createMsg').innerHTML = '<div class="success">✓ Producto creado</div>';
        ['productName','productDesc','productPrice','productSku','productImage'].forEach(id => document.getElementById(id).value = '');
        loadInventory();
      } else {
        const err = await res.json();
        document.getElementById('createMsg').innerHTML = '<div class="error">' + err.error + '</div>';
      }
    } catch (e) {
      document.getElementById('createMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  async function addStock() {
    const product_id = document.getElementById('productSelect').value;
    const quantity = parseInt(document.getElementById('movementQty').value);
    const reason = document.getElementById('movementReason').value;
    if (!product_id || !quantity) {
      document.getElementById('movementMsg').innerHTML = '<div class="error">Selecciona producto y cantidad</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/inventory/entry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ product_id: parseInt(product_id), quantity, reason })
      });
      if (res.ok) {
        document.getElementById('movementMsg').innerHTML = '<div class="success">✓ Stock agregado</div>';
        document.getElementById('movementQty').value = '';
        document.getElementById('movementReason').value = '';
        loadInventory();
      }
    } catch (e) {
      document.getElementById('movementMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  async function removeStock() {
    const product_id = document.getElementById('productSelect').value;
    const quantity = parseInt(document.getElementById('movementQty').value);
    const reason = document.getElementById('movementReason').value;
    if (!product_id || !quantity) {
      document.getElementById('movementMsg').innerHTML = '<div class="error">Selecciona producto y cantidad</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/inventory/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ product_id: parseInt(product_id), quantity, reason })
      });
      if (res.ok) {
        document.getElementById('movementMsg').innerHTML = '<div class="success">✓ Stock reducido</div>';
        document.getElementById('movementQty').value = '';
        document.getElementById('movementReason').value = '';
        loadInventory();
      }
    } catch (e) {
      document.getElementById('movementMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  // ══════════════════════════════════════════════
  // VENTAS
  // ══════════════════════════════════════════════
  async function loadProductsForSale() {
    try {
      const res = await fetch(API_URL + '/api/products', { headers: { 'X-Session-Token': sessionToken } });
      const products = await res.json();
      const options = products.map(p => \`<option value="\${p.id}" data-price="\${p.price}" data-stock="\${p.stock_quantity}">\${p.name} - $\${parseFloat(p.price).toFixed(2)}</option>\`).join('');
      document.getElementById('saleProductSelect').innerHTML = '<option value="">Seleccionar...</option>' + options;
    } catch (e) { console.error(e); }
  }

  function addToCart() {
    const select = document.getElementById('saleProductSelect');
    const product_id = select.value;
    const quantity = parseInt(document.getElementById('saleQty').value);
    const price = parseFloat(select.options[select.selectedIndex].dataset.price);
    const stock = parseInt(select.options[select.selectedIndex].dataset.stock);
    const name = select.options[select.selectedIndex].text.split(' - ')[0];
    if (!product_id || !quantity) return;
    if (quantity > stock) { alert('Stock insuficiente'); return; }
    const existing = cart.find(item => item.product_id == product_id);
    if (existing) { existing.quantity += quantity; } else { cart.push({ product_id: parseInt(product_id), quantity, price, name }); }
    renderCart();
    document.getElementById('saleQty').value = '1';
  }

  function renderCart() {
    const html = cart.map((item, idx) => \`
      <div class="cart-item">
        <div><strong>\${item.name}</strong><br><span style="color:#888;font-size:13px;">\${item.quantity} × $\${item.price.toFixed(2)}</span></div>
        <div style="display:flex;align-items:center;gap:10px;">
          <strong>$\${(item.quantity * item.price).toFixed(2)}</strong>
          <button onclick="removeFromCart(\${idx})" class="danger" style="padding:4px 10px;">✕</button>
        </div>
      </div>
    \`).join('');
    document.getElementById('cartItems').innerHTML = html;
    updateTotal();
  }

  function removeFromCart(idx) { cart.splice(idx, 1); renderCart(); }

  function updateTotal() {
    const subtotal = cart.reduce((sum, item) => sum + (item.quantity * item.price), 0);
    const discountPct = parseFloat(document.getElementById('discountPct').value) || 0;
    const discountAmount = (subtotal * discountPct) / 100;
    const total = subtotal - discountAmount;
    document.getElementById('subtotal').textContent = '$' + subtotal.toFixed(2);
    document.getElementById('discountAmount').textContent = '$' + discountAmount.toFixed(2);
    document.getElementById('totalAmount').textContent = '$' + total.toFixed(2);
  }

  async function completeSale() {
    if (cart.length === 0) {
      document.getElementById('saleMsg').innerHTML = '<div class="error">Carrito vacío</div>';
      return;
    }
    const discount_percentage = parseFloat(document.getElementById('discountPct').value) || 0;
    try {
      const res = await fetch(API_URL + '/api/sales', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ items: cart, discount_percentage })
      });
      if (res.ok) {
        const sale = await res.json();
        document.getElementById('saleMsg').innerHTML = \`<div class="success">✓ Venta #\${sale.id} completada — Total: $\${sale.final_amount}</div>\`;
        cart = [];
        renderCart();
        document.getElementById('discountPct').value = '0';
      } else {
        const error = await res.json();
        document.getElementById('saleMsg').innerHTML = '<div class="error">Error: ' + error.error + '</div>';
      }
    } catch (e) {
      document.getElementById('saleMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  // ══════════════════════════════════════════════
  // REPORTES
  // ══════════════════════════════════════════════
  async function loadTopProducts() {
    try {
      const res = await fetch(API_URL + '/api/reports/top-products', { headers: { 'X-Session-Token': sessionToken } });
      const products = await res.json();
      const html = \`<table><tr><th>Producto</th><th>Vendidos</th><th>Ingresos</th></tr>\${products.map(p => \`<tr><td>\${p.name}</td><td>\${p.total_sold}</td><td>$\${parseFloat(p.total_revenue).toFixed(2)}</td></tr>\`).join('')}</table>\`;
      document.getElementById('topProductsReport').innerHTML = html;
    } catch (e) { console.error(e); }
  }

  async function loadSalesHistory() {
    try {
      const res = await fetch(API_URL + '/api/sales', { headers: { 'X-Session-Token': sessionToken } });
      const sales = await res.json();
      const html = \`<table><tr><th>ID</th><th>Fecha</th><th>Total</th><th>Descuento</th><th>Final</th></tr>\${sales.map(s => \`<tr><td>#\${s.id}</td><td>\${new Date(s.sale_date).toLocaleDateString('es-AR')}</td><td>$\${parseFloat(s.total_amount).toFixed(2)}</td><td>$\${parseFloat(s.discount_amount).toFixed(2)}</td><td><strong>$\${parseFloat(s.final_amount).toFixed(2)}</strong></td></tr>\`).join('')}</table>\`;
      document.getElementById('salesHistoryReport').innerHTML = html;
    } catch (e) { console.error(e); }
  }

  // ══════════════════════════════════════════════
  // PERFIL
  // ══════════════════════════════════════════════
  function loadProfile() {
    if (!currentUser) return;
    const roleBadge = getRoleBadge(currentUser.role_name);
    document.getElementById('profileInfo').innerHTML = \`
      <div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;">
        <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);display:flex;align-items:center;justify-content:center;font-size:28px;color:white;">
          \${currentUser.username[0].toUpperCase()}
        </div>
        <div>
          <strong style="font-size:18px;">\${currentUser.username}</strong><br>
          <span style="color:#888;">\${currentUser.email}</span><br>
          <span class="badge \${roleBadge.cls}" style="margin-top:4px;">\${currentUser.role_name}</span>
        </div>
      </div>
      <div style="background:#f8f8f8;border-radius:8px;padding:14px;">
        <strong style="font-size:13px;color:#555;">Permisos activos:</strong><br>
        <div style="margin-top:8px;">\${userPermissions.map(p => \`<span class="perm-tag">\${p.resource}:\${p.action}</span>\`).join('')}</div>
      </div>
    \`;
  }

  function getRoleBadge(role) {
    const map = { Admin: { cls: 'badge-admin' }, Manager: { cls: 'badge-manager' }, Seller: { cls: 'badge-seller' }, Viewer: { cls: 'badge-viewer' } };
    return map[role] || { cls: 'badge-default' };
  }

  async function changePassword() {
    const currentPwd = document.getElementById('currentPwd').value;
    const newPwd = document.getElementById('newPwd').value;
    const confirmPwd = document.getElementById('confirmPwd').value;
    if (!currentPwd || !newPwd || !confirmPwd) {
      document.getElementById('pwdMsg').innerHTML = '<div class="error">Completa todos los campos</div>';
      return;
    }
    if (newPwd !== confirmPwd) {
      document.getElementById('pwdMsg').innerHTML = '<div class="error">Las contraseñas no coinciden</div>';
      return;
    }
    if (newPwd.length < 6) {
      document.getElementById('pwdMsg').innerHTML = '<div class="error">Mínimo 6 caracteres</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ current_password: currentPwd, new_password: newPwd })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('pwdMsg').innerHTML = '<div class="success">✓ Contraseña actualizada</div>';
        ['currentPwd','newPwd','confirmPwd'].forEach(id => document.getElementById(id).value = '');
      } else {
        document.getElementById('pwdMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('pwdMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  // ══════════════════════════════════════════════
  // ADMIN PANEL
  // ══════════════════════════════════════════════
  function switchAdminTab(tab) {
    document.querySelectorAll('.tab-btn').forEach((btn, i) => {
      const tabs = ['users', 'roles', 'permissions'];
      btn.classList.toggle('active', tabs[i] === tab);
    });
    document.querySelectorAll('.tab-content').forEach(tc => tc.classList.remove('active'));
    document.getElementById('tab-' + tab).classList.add('active');
    if (tab === 'users') loadAdminUsers();
    if (tab === 'roles') loadAdminRoles();
    if (tab === 'permissions') loadAdminPermissions();
  }

  async function loadAdminPanel() {
    await loadAdminStats();
    await loadAdminUsers();
  }

  async function loadAdminStats() {
    try {
      const [usersRes, rolesRes, permsRes] = await Promise.all([
        fetch(API_URL + '/api/admin/users', { headers: { 'X-Session-Token': sessionToken } }),
        fetch(API_URL + '/api/admin/roles', { headers: { 'X-Session-Token': sessionToken } }),
        fetch(API_URL + '/api/admin/permissions', { headers: { 'X-Session-Token': sessionToken } })
      ]);
      const users = await usersRes.json();
      const roles = await rolesRes.json();
      const perms = await permsRes.json();
      document.getElementById('adminStats').innerHTML = \`
        <div class="stat-card"><div class="stat-icon">👥</div><div class="stat-info"><strong>\${users.length}</strong><span>Usuarios</span></div></div>
        <div class="stat-card"><div class="stat-icon">🎭</div><div class="stat-info"><strong>\${roles.length}</strong><span>Roles</span></div></div>
        <div class="stat-card"><div class="stat-icon">🔑</div><div class="stat-info"><strong>\${perms.length}</strong><span>Permisos</span></div></div>
      \`;
    } catch (e) { console.error(e); }
  }

  async function loadAdminUsers() {
    try {
      const [usersRes, rolesRes] = await Promise.all([
        fetch(API_URL + '/api/admin/users', { headers: { 'X-Session-Token': sessionToken } }),
        fetch(API_URL + '/api/admin/roles', { headers: { 'X-Session-Token': sessionToken } })
      ]);
      const users = await usersRes.json();
      const roles = await rolesRes.json();

      const html = \`<table>
        <tr><th>Usuario</th><th>Email</th><th>Rol</th><th>Creado</th></tr>
        \${users.map(u => \`<tr>
          <td><strong>\${u.username}</strong></td>
          <td>\${u.email}</td>
          <td><span class="badge \${getRoleBadge(u.role_name).cls}">\${u.role_name || '-'}</span></td>
          <td>\${new Date(u.created_at).toLocaleDateString('es-AR')}</td>
        </tr>\`).join('')}
      </table>\`;
      document.getElementById('usersList').innerHTML = html;

      const userOptions = users.map(u => \`<option value="\${u.id}">\${u.username} (\${u.role_name})</option>\`).join('');
      document.getElementById('changeRoleUser').innerHTML = userOptions;
      const roleOptions = roles.map(r => \`<option value="\${r.id}">\${r.name}</option>\`).join('');
      document.getElementById('changeRoleSelect').innerHTML = roleOptions;
    } catch (e) { console.error(e); }
  }

  async function changeUserRole() {
    const userId = document.getElementById('changeRoleUser').value;
    const roleId = document.getElementById('changeRoleSelect').value;
    if (!userId || !roleId) return;
    try {
      const res = await fetch(API_URL + '/api/admin/users/' + userId + '/role', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ role_id: parseInt(roleId) })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('changeRoleMsg').innerHTML = '<div class="success">✓ Rol actualizado</div>';
        loadAdminUsers();
        loadAdminStats();
      } else {
        document.getElementById('changeRoleMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('changeRoleMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  async function loadAdminRoles() {
    try {
      const res = await fetch(API_URL + '/api/admin/roles', { headers: { 'X-Session-Token': sessionToken } });
      const roles = await res.json();
      const html = \`<table>
        <tr><th>Nombre</th><th>Descripción</th><th>Creado</th><th>Acción</th></tr>
        \${roles.map(r => \`<tr>
          <td><span class="badge \${getRoleBadge(r.name).cls}">\${r.name}</span></td>
          <td>\${r.description || '-'}</td>
          <td>\${new Date(r.created_at).toLocaleDateString('es-AR')}</td>
          <td>\${!['Admin','Manager','Seller','Viewer'].includes(r.name) ? \`<button class="danger" style="padding:4px 10px;font-size:12px;" onclick="deleteRole(\${r.id})">Eliminar</button>\` : '<span style="color:#aaa;font-size:12px;">Sistema</span>'}</td>
        </tr>\`).join('')}
      </table>\`;
      document.getElementById('rolesList').innerHTML = html;
    } catch (e) { console.error(e); }
  }

  async function createRole() {
    const name = document.getElementById('newRoleName').value.trim();
    const description = document.getElementById('newRoleDesc').value.trim();
    if (!name) {
      document.getElementById('createRoleMsg').innerHTML = '<div class="error">El nombre es requerido</div>';
      return;
    }
    try {
      const res = await fetch(API_URL + '/api/admin/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ name, description })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('createRoleMsg').innerHTML = '<div class="success">✓ Rol creado</div>';
        document.getElementById('newRoleName').value = '';
        document.getElementById('newRoleDesc').value = '';
        loadAdminRoles();
        loadAdminStats();
      } else {
        document.getElementById('createRoleMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('createRoleMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  async function deleteRole(id) {
    if (!confirm('¿Eliminar este rol?')) return;
    try {
      const res = await fetch(API_URL + '/api/admin/roles/' + id, {
        method: 'DELETE',
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.ok) { loadAdminRoles(); loadAdminStats(); }
      else { const d = await res.json(); alert(d.error); }
    } catch (e) { alert('Error: ' + e.message); }
  }

  async function loadAdminPermissions() {
    try {
      const rolesRes = await fetch(API_URL + '/api/admin/roles', { headers: { 'X-Session-Token': sessionToken } });
      const roles = await rolesRes.json();
      const roleOptions = roles.map(r => \`<option value="\${r.id}">\${r.name}</option>\`).join('');
      document.getElementById('permFilterRole').innerHTML = '<option value="">Todos</option>' + roleOptions;
      document.getElementById('permRoleSelect').innerHTML = roleOptions;
      loadPermissions();
    } catch (e) { console.error(e); }
  }

  async function loadPermissions() {
    try {
      const filterRole = document.getElementById('permFilterRole')?.value;
      const url = filterRole
        ? API_URL + '/api/admin/permissions?role_id=' + filterRole
        : API_URL + '/api/admin/permissions';
      const res = await fetch(url, { headers: { 'X-Session-Token': sessionToken } });
      const perms = await res.json();
      const html = \`<table>
        <tr><th>Rol</th><th>Recurso</th><th>Acción</th><th></th></tr>
        \${perms.map(p => \`<tr>
          <td><span class="badge \${getRoleBadge(p.role_name).cls}">\${p.role_name}</span></td>
          <td><span class="perm-tag">\${p.resource}</span></td>
          <td><span class="perm-tag">\${p.action}</span></td>
          <td><button class="danger" style="padding:3px 8px;font-size:12px;" onclick="deletePermission(\${p.id})">✕</button></td>
        </tr>\`).join('')}
      </table>\`;
      document.getElementById('permissionsList').innerHTML = html;
    } catch (e) { console.error(e); }
  }

  async function assignPermission() {
    const role_id = parseInt(document.getElementById('permRoleSelect').value);
    const resource = document.getElementById('permResource').value;
    const action = document.getElementById('permAction').value;
    try {
      const res = await fetch(API_URL + '/api/admin/permissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': sessionToken },
        body: JSON.stringify({ role_id, resource, action })
      });
      const data = await res.json();
      if (res.ok) {
        document.getElementById('assignPermMsg').innerHTML = '<div class="success">✓ Permiso asignado</div>';
        loadPermissions();
        loadAdminStats();
      } else {
        document.getElementById('assignPermMsg').innerHTML = '<div class="error">' + data.error + '</div>';
      }
    } catch (e) {
      document.getElementById('assignPermMsg').innerHTML = '<div class="error">Error: ' + e.message + '</div>';
    }
  }

  async function deletePermission(id) {
    try {
      const res = await fetch(API_URL + '/api/admin/permissions/' + id, {
        method: 'DELETE',
        headers: { 'X-Session-Token': sessionToken }
      });
      if (res.ok) { loadPermissions(); loadAdminStats(); }
      else { const d = await res.json(); alert(d.error); }
    } catch (e) { alert('Error: ' + e.message); }
  }

  // ══════════════════════════════════════════════
  // BOOTSTRAP
  // ══════════════════════════════════════════════
  if (sessionToken) {
    initApp();
  }

  // Allow Enter key on login
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const loginForm = document.getElementById('loginForm');
      if (loginForm && loginForm.style.display !== 'none' && document.getElementById('authOverlay').style.display !== 'none') {
        doLogin();
      }
    }
  });
</script>
</body>
</html>`);
});

// ===== API ENDPOINTS =====

// GET todos los productos
app.get("/api/products", async (c) => {
  try {
    const products = await sql`SELECT * FROM products ORDER BY created_at DESC`;
    return c.json(products);
  } catch (error) {
    console.error("Error en GET /api/products:", error);
    return c.json({ error: "Error al obtener productos" }, 500);
  }
});

// POST crear producto
app.post("/api/products", async (c) => {
  try {
    const body = await c.req.json();
    const { name, description, price, sku, image_url } = body;
    
    if (!name || !price) {
      return c.json({ error: "Nombre y precio requeridos" }, 400);
    }
    
    const result = await sql`
      INSERT INTO products (name, description, price, sku, image_url, stock_quantity)
      VALUES (${name}, ${description || null}, ${price}, ${sku || null}, ${image_url || null}, 0)
      RETURNING *
    `;
    return c.json(result[0], 201);
  } catch (error) {
    console.error("Error en POST /api/products:", error);
    return c.json({ error: "Error al crear producto" }, 500);
  }
});

// POST entrada de inventario
app.post("/api/inventory/entry", async (c) => {
  try {
    const body = await c.req.json();
    const { product_id, quantity, reason } = body;
    
    if (!product_id || !quantity) {
      return c.json({ error: "product_id y quantity requeridos" }, 400);
    }
    
    await sql`
      INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
      VALUES (${product_id}, 'ENTRY', ${quantity}, ${reason || null})
    `;
    
    const result = await sql`
      UPDATE products SET stock_quantity = stock_quantity + ${quantity}
      WHERE id = ${product_id} RETURNING *
    `;
    
    return c.json({ message: "Entrada registrada", product: result[0] }, 201);
  } catch (error) {
    console.error("Error en POST /api/inventory/entry:", error);
    return c.json({ error: "Error al registrar entrada" }, 500);
  }
});

// POST salida de inventario
app.post("/api/inventory/exit", async (c) => {
  try {
    const body = await c.req.json();
    const { product_id, quantity, reason } = body;
    
    if (!product_id || !quantity) {
      return c.json({ error: "product_id y quantity requeridos" }, 400);
    }
    
    const product = await sql`SELECT stock_quantity FROM products WHERE id = ${product_id}`;
    
    if (product.length === 0) {
      return c.json({ error: "Producto no encontrado" }, 404);
    }
    
    if (product[0].stock_quantity < quantity) {
      return c.json({ error: "Stock insuficiente" }, 400);
    }
    
    await sql`
      INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
      VALUES (${product_id}, 'EXIT', ${quantity}, ${reason || null})
    `;
    
    const result = await sql`
      UPDATE products SET stock_quantity = stock_quantity - ${quantity}
      WHERE id = ${product_id} RETURNING *
    `;
    
    return c.json({ message: "Salida registrada", product: result[0] }, 201);
  } catch (error) {
    console.error("Error en POST /api/inventory/exit:", error);
    return c.json({ error: "Error al registrar salida" }, 500);
  }
});

// POST crear venta
app.post("/api/sales", async (c) => {
  try {
    const body = await c.req.json();
    const { items, discount_percentage = 0 } = body;
    
    if (!items || items.length === 0) {
      return c.json({ error: "Items requeridos" }, 400);
    }
    
    let total_amount = 0;
    
    for (const item of items) {
      const product = await sql`SELECT price, stock_quantity FROM products WHERE id = ${item.product_id}`;
      
      if (product.length === 0) {
        return c.json({ error: `Producto ${item.product_id} no encontrado` }, 404);
      }
      
      if (product[0].stock_quantity < item.quantity) {
        return c.json({ error: `Stock insuficiente para producto ${item.product_id}` }, 400);
      }
      
      total_amount += product[0].price * item.quantity;
    }
    
    const discount_amount = (total_amount * discount_percentage) / 100;
    const final_amount = total_amount - discount_amount;
    
    const sale = await sql`
      INSERT INTO sales (total_amount, discount_amount, final_amount)
      VALUES (${total_amount}, ${discount_amount}, ${final_amount})
      RETURNING *
    `;
    
    const sale_id = sale[0].id;
    
    for (const item of items) {
      const product = await sql`SELECT price FROM products WHERE id = ${item.product_id}`;
      const unit_price = product[0].price;
      const subtotal = unit_price * item.quantity;
      
      await sql`
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (${sale_id}, ${item.product_id}, ${item.quantity}, ${unit_price}, ${subtotal})
      `;
      
      await sql`UPDATE products SET stock_quantity = stock_quantity - ${item.quantity} WHERE id = ${item.product_id}`;
      
      await sql`
        INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
        VALUES (${item.product_id}, 'EXIT', ${item.quantity}, 'VENTA #' || ${sale_id})
      `;
    }
    
    const saleDetails = await sql`SELECT * FROM sale_items WHERE sale_id = ${sale_id}`;
    return c.json({ ...sale[0], items: saleDetails }, 201);
  } catch (error) {
    console.error("Error en POST /api/sales:", error);
    return c.json({ error: "Error al crear venta" }, 500);
  }
});

// GET todas las ventas
app.get("/api/sales", async (c) => {
  try {
    const sales = await sql`SELECT * FROM sales ORDER BY sale_date DESC`;
    return c.json(sales);
  } catch (error) {
    console.error("Error en GET /api/sales:", error);
    return c.json({ error: "Error al obtener ventas" }, 500);
  }
});

// GET productos más vendidos
app.get("/api/reports/top-products", async (c) => {
  try {
    const topProducts = await sql`
      SELECT 
        p.id, p.name,
        SUM(si.quantity) as total_sold,
        SUM(si.subtotal) as total_revenue
      FROM sale_items si
      JOIN products p ON si.product_id = p.id
      GROUP BY p.id, p.name
      ORDER BY total_sold DESC
      LIMIT 10
    `;
    return c.json(topProducts);
  } catch (error) {
    console.error("Error en GET /api/reports/top-products:", error);
    return c.json({ error: "Error al obtener reportes" }, 500);
  }
});

// ===== AUTH ENDPOINTS =====

// POST /api/auth/register
app.post("/api/auth/register", async (c) => {
  try {
    const body = await c.req.json();
    const { username, email, password } = body;

    if (!username || !email || !password) {
      return c.json({ error: "username, email y password son requeridos" }, 400);
    }
    if (password.length < 6) {
      return c.json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);
    }

    // Check duplicates
    const existing = await sql`
      SELECT id FROM users WHERE username = ${username} OR email = ${email}
    `;
    if (existing.length > 0) {
      return c.json({ error: "El usuario o email ya existe" }, 409);
    }

    // Assign Viewer role by default
    const viewerRole = await sql`SELECT id FROM roles WHERE name = 'Viewer' LIMIT 1`;
    const roleId = viewerRole.length > 0 ? viewerRole[0].id : null;

    const passwordHash = hashPassword(password);
    const result = await sql`
      INSERT INTO users (username, password_hash, email, role_id)
      VALUES (${username}, ${passwordHash}, ${email}, ${roleId})
      RETURNING id, username, email, role_id, created_at
    `;
    return c.json({ message: "Usuario creado", user: result[0] }, 201);
  } catch (error) {
    console.error("Error en POST /api/auth/register:", error);
    return c.json({ error: "Error al registrar usuario" }, 500);
  }
});

// POST /api/auth/login
app.post("/api/auth/login", async (c) => {
  try {
    const body = await c.req.json();
    const { username, password } = body;

    if (!username || !password) {
      return c.json({ error: "username y password son requeridos" }, 400);
    }

    const users = await sql`
      SELECT u.id, u.username, u.email, u.role_id, u.password_hash, r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      WHERE u.username = ${username}
    `;

    if (users.length === 0) {
      return c.json({ error: "Credenciales inválidas" }, 401);
    }

    const user = users[0];
    const hash = hashPassword(password);
    if (hash !== user.password_hash) {
      return c.json({ error: "Credenciales inválidas" }, 401);
    }

    // Create session (24h)
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await sql`
      INSERT INTO user_sessions (user_id, token, expires_at)
      VALUES (${user.id}, ${token}, ${expiresAt})
    `;

    return c.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role_id: user.role_id,
        role_name: user.role_name
      }
    });
  } catch (error) {
    console.error("Error en POST /api/auth/login:", error);
    return c.json({ error: "Error al iniciar sesión" }, 500);
  }
});

// POST /api/auth/logout
app.post("/api/auth/logout", async (c) => {
  try {
    const token = c.req.header("X-Session-Token") || c.req.header("Authorization")?.replace("Bearer ", "");
    if (token) {
      await sql`DELETE FROM user_sessions WHERE token = ${token}`;
    }
    return c.json({ message: "Sesión cerrada" });
  } catch (error) {
    console.error("Error en POST /api/auth/logout:", error);
    return c.json({ error: "Error al cerrar sesión" }, 500);
  }
});

// GET /api/auth/me
app.get("/api/auth/me", authMiddleware, async (c) => {
  try {
    const user = c.get("user") as any;
    const permissions = await getUserPermissions(user.role_id);
    return c.json({ user, permissions });
  } catch (error) {
    console.error("Error en GET /api/auth/me:", error);
    return c.json({ error: "Error al obtener usuario" }, 500);
  }
});

// POST /api/auth/change-password
app.post("/api/auth/change-password", authMiddleware, async (c) => {
  try {
    const user = c.get("user") as any;
    const body = await c.req.json();
    const { current_password, new_password } = body;

    if (!current_password || !new_password) {
      return c.json({ error: "current_password y new_password son requeridos" }, 400);
    }
    if (new_password.length < 6) {
      return c.json({ error: "La nueva contraseña debe tener al menos 6 caracteres" }, 400);
    }

    const users = await sql`SELECT password_hash FROM users WHERE id = ${user.id}`;
    if (users.length === 0) return c.json({ error: "Usuario no encontrado" }, 404);

    if (hashPassword(current_password) !== users[0].password_hash) {
      return c.json({ error: "Contraseña actual incorrecta" }, 401);
    }

    await sql`UPDATE users SET password_hash = ${hashPassword(new_password)} WHERE id = ${user.id}`;
    return c.json({ message: "Contraseña actualizada" });
  } catch (error) {
    console.error("Error en POST /api/auth/change-password:", error);
    return c.json({ error: "Error al cambiar contraseña" }, 500);
  }
});

// ===== ADMIN ENDPOINTS =====

// GET /api/admin/roles
app.get("/api/admin/roles", adminMiddleware, async (c) => {
  try {
    const roles = await sql`SELECT * FROM roles ORDER BY id ASC`;
    return c.json(roles);
  } catch (error) {
    console.error("Error en GET /api/admin/roles:", error);
    return c.json({ error: "Error al obtener roles" }, 500);
  }
});

// POST /api/admin/roles
app.post("/api/admin/roles", adminMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const { name, description } = body;
    if (!name) return c.json({ error: "name es requerido" }, 400);

    const existing = await sql`SELECT id FROM roles WHERE name = ${name}`;
    if (existing.length > 0) return c.json({ error: "Ya existe un rol con ese nombre" }, 409);

    const result = await sql`
      INSERT INTO roles (name, description) VALUES (${name}, ${description || null}) RETURNING *
    `;
    return c.json(result[0], 201);
  } catch (error) {
    console.error("Error en POST /api/admin/roles:", error);
    return c.json({ error: "Error al crear rol" }, 500);
  }
});

// PUT /api/admin/roles/:id
app.put("/api/admin/roles/:id", adminMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json();
    const { name, description } = body;

    const result = await sql`
      UPDATE roles SET name = COALESCE(${name || null}, name), description = COALESCE(${description || null}, description)
      WHERE id = ${id} RETURNING *
    `;
    if (result.length === 0) return c.json({ error: "Rol no encontrado" }, 404);
    return c.json(result[0]);
  } catch (error) {
    console.error("Error en PUT /api/admin/roles/:id:", error);
    return c.json({ error: "Error al actualizar rol" }, 500);
  }
});

// DELETE /api/admin/roles/:id
app.delete("/api/admin/roles/:id", adminMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const role = await sql`SELECT name FROM roles WHERE id = ${id}`;
    if (role.length === 0) return c.json({ error: "Rol no encontrado" }, 404);
    if (["Admin", "Manager", "Seller", "Viewer"].includes(role[0].name)) {
      return c.json({ error: "No se pueden eliminar los roles del sistema" }, 400);
    }
    await sql`DELETE FROM roles WHERE id = ${id}`;
    return c.json({ message: "Rol eliminado" });
  } catch (error) {
    console.error("Error en DELETE /api/admin/roles/:id:", error);
    return c.json({ error: "Error al eliminar rol" }, 500);
  }
});

// GET /api/admin/permissions
app.get("/api/admin/permissions", adminMiddleware, async (c) => {
  try {
    const roleId = c.req.query("role_id");
    let perms;
    if (roleId) {
      perms = await sql`
        SELECT p.*, r.name as role_name FROM permissions p
        JOIN roles r ON p.role_id = r.id
        WHERE p.role_id = ${parseInt(roleId)}
        ORDER BY r.name, p.resource, p.action
      `;
    } else {
      perms = await sql`
        SELECT p.*, r.name as role_name FROM permissions p
        JOIN roles r ON p.role_id = r.id
        ORDER BY r.name, p.resource, p.action
      `;
    }
    return c.json(perms);
  } catch (error) {
    console.error("Error en GET /api/admin/permissions:", error);
    return c.json({ error: "Error al obtener permisos" }, 500);
  }
});

// POST /api/admin/permissions
app.post("/api/admin/permissions", adminMiddleware, async (c) => {
  try {
    const body = await c.req.json();
    const { role_id, resource, action } = body;
    if (!role_id || !resource || !action) {
      return c.json({ error: "role_id, resource y action son requeridos" }, 400);
    }

    const existing = await sql`
      SELECT id FROM permissions WHERE role_id = ${role_id} AND resource = ${resource} AND action = ${action}
    `;
    if (existing.length > 0) return c.json({ error: "Este permiso ya existe" }, 409);

    const result = await sql`
      INSERT INTO permissions (role_id, resource, action) VALUES (${role_id}, ${resource}, ${action}) RETURNING *
    `;
    return c.json(result[0], 201);
  } catch (error) {
    console.error("Error en POST /api/admin/permissions:", error);
    return c.json({ error: "Error al asignar permiso" }, 500);
  }
});

// DELETE /api/admin/permissions/:id
app.delete("/api/admin/permissions/:id", adminMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const result = await sql`DELETE FROM permissions WHERE id = ${id} RETURNING id`;
    if (result.length === 0) return c.json({ error: "Permiso no encontrado" }, 404);
    return c.json({ message: "Permiso eliminado" });
  } catch (error) {
    console.error("Error en DELETE /api/admin/permissions/:id:", error);
    return c.json({ error: "Error al eliminar permiso" }, 500);
  }
});

// GET /api/admin/users
app.get("/api/admin/users", adminMiddleware, async (c) => {
  try {
    const users = await sql`
      SELECT u.id, u.username, u.email, u.role_id, u.created_at, r.name as role_name
      FROM users u
      LEFT JOIN roles r ON u.role_id = r.id
      ORDER BY u.created_at DESC
    `;
    return c.json(users);
  } catch (error) {
    console.error("Error en GET /api/admin/users:", error);
    return c.json({ error: "Error al obtener usuarios" }, 500);
  }
});

// PUT /api/admin/users/:id/role
app.put("/api/admin/users/:id/role", adminMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param("id"));
    const body = await c.req.json();
    const { role_id } = body;
    if (!role_id) return c.json({ error: "role_id es requerido" }, 400);

    const role = await sql`SELECT id FROM roles WHERE id = ${role_id}`;
    if (role.length === 0) return c.json({ error: "Rol no encontrado" }, 404);

    const result = await sql`
      UPDATE users SET role_id = ${role_id} WHERE id = ${id}
      RETURNING id, username, email, role_id, created_at
    `;
    if (result.length === 0) return c.json({ error: "Usuario no encontrado" }, 404);
    return c.json(result[0]);
  } catch (error) {
    console.error("Error en PUT /api/admin/users/:id/role:", error);
    return c.json({ error: "Error al actualizar rol de usuario" }, 500);
  }
});

// GET /admin (redirect to main app)
app.get("/admin", (c) => {
  return c.redirect("/");
});

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Iniciar servidor con Bun
const port = parseInt(process.env.PORT || "3000");
Bun.serve({
  port: port,
  fetch: app.fetch,
  onError: (error) => {
    console.error("Error en el servidor:", error);
    return new Response("Error interno del servidor", { status: 500 });
  },
});

console.log(`🚀 Servidor iniciado en http://localhost:${port}`);