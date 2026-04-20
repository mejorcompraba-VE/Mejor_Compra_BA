/// <reference types="bun-types" />
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import path from "path";

const app = new Hono();
app.use("/*", cors());

// Servir archivos estáticos del frontend
app.use("/*", serveStatic({ 
  root: path.join(import.meta.dir, '../../frontend'),
  rewriteRequestPath: (path) => {
    if (path === '/') return '/index.html';
    return path.startsWith('/api') ? path : `/index.html`;
  }
}));

// ===== INICIALIZAR TABLAS =====
try {
  await Bun.sql`
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

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS inventory_movements (
      id SERIAL PRIMARY KEY,
      product_id INT NOT NULL REFERENCES products(id),
      movement_type VARCHAR(10) NOT NULL,
      quantity INT NOT NULL,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS sales (
      id SERIAL PRIMARY KEY,
      sale_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      total_amount DECIMAL(10, 2) NOT NULL,
      discount_amount DECIMAL(10, 2) DEFAULT 0,
      final_amount DECIMAL(10, 2) NOT NULL,
      status VARCHAR(20) DEFAULT 'COMPLETED'
    )
  `;

  await Bun.sql`
    CREATE TABLE IF NOT EXISTS sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INT NOT NULL REFERENCES sales(id),
      product_id INT NOT NULL,
      quantity INT NOT NULL,
      unit_price DECIMAL(10, 2) NOT NULL,
      subtotal DECIMAL(10, 2) NOT NULL
    )
  `;

  console.log("✓ Tablas creadas correctamente");
} catch (error) {
  console.error("Error creando tablas:", error);
}

// ===== PÁGINA PRINCIPAL =====
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
    header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 20px; text-align: center; }
    nav { background: #333; padding: 15px; display: flex; gap: 20px; justify-content: center; flex-wrap: wrap; }
    nav a { color: white; text-decoration: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; }
    nav a:hover { background: #667eea; }
    .container { max-width: 1200px; margin: 20px auto; padding: 20px; }
    .section { display: none; }
    .section.active { display: block; }
    .products-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 20px; }
    .product-card { background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    .product-image { width: 100%; height: 200px; background: #ddd; display: flex; align-items: center; justify-content: center; font-size: 60px; }
    .product-image img { width: 100%; height: 100%; object-fit: cover; }
    .product-info { padding: 15px; }
    .product-name { font-weight: bold; font-size: 16px; margin-bottom: 5px; }
    .product-price { color: #667eea; font-size: 18px; font-weight: bold; margin: 10px 0; }
    .product-stock { color: #666; font-size: 14px; }
    button { background: #667eea; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; font-size: 14px; }
    button:hover { background: #764ba2; }
    input, textarea, select { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
    .form-group { margin-bottom: 15px; }
    label { display: block; font-weight: bold; margin-bottom: 5px; }
    .cart-item { background: white; padding: 15px; margin: 10px 0; border-radius: 5px; display: flex; justify-content: space-between; align-items: center; }
    .success { color: green; padding: 10px; background: #e8f5e9; border-radius: 5px; margin: 10px 0; }
    .error { color: red; padding: 10px; background: #ffebee; border-radius: 5px; margin: 10px 0; }
    table { width: 100%; border-collapse: collapse; background: white; margin-top: 20px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #667eea; color: white; }
  </style>
</head>
<body>
  <header>
    <h1>🛍️ Tienda Virtual - Mejor Compra BA</h1>
    <p>Gestión de Inventario y Ventas</p>
  </header>

  <nav>
    <a onclick="showSection('tienda')">🏪 Tienda</a>
    <a onclick="showSection('inventario')">📦 Inventario</a>
    <a onclick="showSection('ventas')">💳 Ventas</a>
    <a onclick="showSection('reportes')">📊 Reportes</a>
  </nav>

  <div class="container">
    <div id="tienda" class="section active">
      <h2>Catálogo de Productos</h2>
      <div id="productsList" class="products-grid"></div>
    </div>

    <div id="inventario" class="section">
      <h2>Gestión de Inventario</h2>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Crear Producto</h3>
          <div class="form-group">
            <label>Nombre</label>
            <input type="text" id="productName" placeholder="Nombre del producto">
          </div>
          <div class="form-group">
            <label>Descripción</label>
            <textarea id="productDesc" placeholder="Descripción"></textarea>
          </div>
          <div class="form-group">
            <label>Precio</label>
            <input type="number" id="productPrice" placeholder="0.00" step="0.01">
          </div>
          <div class="form-group">
            <label>SKU</label>
            <input type="text" id="productSku" placeholder="SKU único">
          </div>
          <div class="form-group">
            <label>URL Imagen</label>
            <input type="text" id="productImage" placeholder="https://...">
          </div>
          <button onclick="createProduct()">Crear Producto</button>
          <div id="createMsg"></div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Movimiento de Stock</h3>
          <div class="form-group">
            <label>Producto</label>
            <select id="productSelect"></select>
          </div>
          <div class="form-group">
            <label>Cantidad</label>
            <input type="number" id="movementQty" placeholder="0" min="1">
          </div>
          <div class="form-group">
            <label>Razón</label>
            <input type="text" id="movementReason" placeholder="Compra, devolución, etc.">
          </div>
          <button onclick="addStock()">➕ Entrada</button>
          <button onclick="removeStock()">➖ Salida</button>
          <div id="movementMsg"></div>
        </div>
      </div>

      <h3 style="margin-top: 30px;">Productos en Inventario</h3>
      <div id="inventoryList"></div>
    </div>

    <div id="ventas" class="section">
      <h2>Módulo de Ventas</h2>
      <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 20px;">
        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Carrito de Compras</h3>
          <div class="form-group">
            <label>Seleccionar Producto</label>
            <select id="saleProductSelect"></select>
          </div>
          <div class="form-group">
            <label>Cantidad</label>
            <input type="number" id="saleQty" placeholder="1" min="1" value="1">
          </div>
          <button onclick="addToCart()">Agregar al Carrito</button>
          <div id="cartItems"></div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Resumen de Venta</h3>
          <div style="margin: 20px 0;">
            <p>Subtotal: <strong id="subtotal">$0.00</strong></p>
            <div class="form-group">
              <label>Descuento (%)</label>
              <input type="number" id="discountPct" placeholder="0" min="0" max="100" value="0" onchange="updateTotal()">
            </div>
            <p>Descuento: <strong id="discountAmount">$0.00</strong></p>
            <p style="font-size: 20px; color: #667eea;">Total: <strong id="totalAmount">$0.00</strong></p>
          </div>
          <button onclick="completeSale()" style="width: 100%; padding: 15px; font-size: 16px;">Completar Venta</button>
          <div id="saleMsg"></div>
        </div>
      </div>
    </div>

    <div id="reportes" class="section">
      <h2>Reportes</h2>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 30px;">
        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Productos Más Vendidos</h3>
          <button onclick="loadTopProducts()">Cargar Reporte</button>
          <div id="topProductsReport"></div>
        </div>

        <div style="background: white; padding: 20px; border-radius: 8px;">
          <h3>Historial de Ventas</h3>
          <button onclick="loadSalesHistory()">Cargar Historial</button>
          <div id="salesHistoryReport"></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const API_URL = window.location.origin;
    let cart = [];

    function showSection(sectionId) {
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      document.getElementById(sectionId).classList.add('active');
      if (sectionId === 'tienda') loadProducts();
      if (sectionId === 'inventario') { loadProducts(); loadInventory(); }
      if (sectionId === 'ventas') { loadProducts(); loadProductsForSale(); }
    }

    async function loadProducts() {
      try {
        const res = await fetch(API_URL + '/api/products');
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
        document.getElementById('productsList').innerHTML = html;
      } catch (e) { console.error(e); }
    }

    async function loadInventory() {
      try {
        const res = await fetch(API_URL + '/api/products');
        const products = await res.json();
        const html = \`<table><tr><th>Producto</th><th>Precio</th><th>Stock</th><th>SKU</th></tr>\${products.map(p => \`<tr><td>\${p.name}</td><td>$\${parseFloat(p.price).toFixed(2)}</td><td>\${p.stock_quantity}</td><td>\${p.sku || '-'}</td></tr>\`).join('')}</table>\`;
        document.getElementById('inventoryList').innerHTML = html;
        const options = products.map(p => \`<option value="\${p.id}">\${p.name}</option>\`).join('');
        document.getElementById('productSelect').innerHTML = '<option value="">Seleccionar...</option>' + options;
      } catch (e) { console.error(e); }
    }

    async function loadProductsForSale() {
      try {
        const res = await fetch(API_URL + '/api/products');
        const products = await res.json();
        const options = products.map(p => \`<option value="\${p.id}" data-price="\${p.price}" data-stock="\${p.stock_quantity}">\${p.name} - $\${parseFloat(p.price).toFixed(2)}</option>\`).join('');
        document.getElementById('saleProductSelect').innerHTML = '<option value="">Seleccionar...</option>' + options;
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, price: parseFloat(price), sku, image_url })
        });
        if (res.ok) {
          document.getElementById('createMsg').innerHTML = '<div class="success">✓ Producto creado</div>';
          document.getElementById('productName').value = '';
          document.getElementById('productDesc').value = '';
          document.getElementById('productPrice').value = '';
          document.getElementById('productSku').value = '';
          document.getElementById('productImage').value = '';
          loadInventory();
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
          headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
      if (existing) {
        existing.quantity += quantity;
      } else {
        cart.push({ product_id: parseInt(product_id), quantity, price, name });
      }

      renderCart();
      document.getElementById('saleQty').value = '1';
    }

    function renderCart() {
      const html = cart.map((item, idx) => \`
        <div class="cart-item">
          <div><strong>\${item.name}</strong><br>\${item.quantity} x $\${item.price.toFixed(2)}</div>
          <div><strong>$\${(item.quantity * item.price).toFixed(2)}</strong><button onclick="removeFromCart(\${idx})" style="margin-left: 10px; background: #f44336;">✕</button></div>
        </div>
      \`).join('');
      document.getElementById('cartItems').innerHTML = html;
      updateTotal();
    }

    function removeFromCart(idx) {
      cart.splice(idx, 1);
      renderCart();
    }

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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: cart, discount_percentage })
        });
        if (res.ok) {
          const sale = await res.json();
          document.getElementById('saleMsg').innerHTML = \`<div class="success">✓ Venta #\${sale.id} completada - Total: $\${sale.final_amount}</div>\`;
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

    async function loadTopProducts() {
      try {
        const res = await fetch(API_URL + '/api/reports/top-products');
        const products = await res.json();
        const html = \`<table><tr><th>Producto</th><th>Vendidos</th><th>Ingresos</th></tr>\${products.map(p => \`<tr><td>\${p.name}</td><td>\${p.total_sold}</td><td>$\${parseFloat(p.total_revenue).toFixed(2)}</td></tr>\`).join('')}</table>\`;
        document.getElementById('topProductsReport').innerHTML = html;
      } catch (e) { console.error(e); }
    }

    async function loadSalesHistory() {
      try {
        const res = await fetch(API_URL + '/api/sales');
        const sales = await res.json();
        const html = \`<table><tr><th>ID</th><th>Fecha</th><th>Total</th><th>Descuento</th><th>Final</th></tr>\${sales.map(s => \`<tr><td>#\${s.id}</td><td>\${new Date(s.sale_date).toLocaleDateString()}</td><td>$\${parseFloat(s.total_amount).toFixed(2)}</td><td>$\${parseFloat(s.discount_amount).toFixed(2)}</td><td><strong>$\${parseFloat(s.final_amount).toFixed(2)}</strong></td></tr>\`).join('')}</table>\`;
        document.getElementById('salesHistoryReport').innerHTML = html;
      } catch (e) { console.error(e); }
    }

    loadProducts();
  </script>
</body>
</html>`);
});

// ===== API ENDPOINTS =====

// GET todos los productos
app.get("/api/products", async (c) => {
  try {
    const products = await Bun.sql`SELECT * FROM products ORDER BY created_at DESC`;
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
    
    const result = await Bun.sql`
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
    
    await Bun.sql`
      INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
      VALUES (${product_id}, 'ENTRY', ${quantity}, ${reason || null})
    `;
    
    const result = await Bun.sql`
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
    
    const product = await Bun.sql`SELECT stock_quantity FROM products WHERE id = ${product_id}`;
    
    if (product.length === 0) {
      return c.json({ error: "Producto no encontrado" }, 404);
    }
    
    if (product[0].stock_quantity < quantity) {
      return c.json({ error: "Stock insuficiente" }, 400);
    }
    
    await Bun.sql`
      INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
      VALUES (${product_id}, 'EXIT', ${quantity}, ${reason || null})
    `;
    
    const result = await Bun.sql`
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
      const product = await Bun.sql`SELECT price, stock_quantity FROM products WHERE id = ${item.product_id}`;
      
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
    
    const sale = await Bun.sql`
      INSERT INTO sales (total_amount, discount_amount, final_amount)
      VALUES (${total_amount}, ${discount_amount}, ${final_amount})
      RETURNING *
    `;
    
    const sale_id = sale[0].id;
    
    for (const item of items) {
      const product = await Bun.sql`SELECT price FROM products WHERE id = ${item.product_id}`;
      const unit_price = product[0].price;
      const subtotal = unit_price * item.quantity;
      
      await Bun.sql`
        INSERT INTO sale_items (sale_id, product_id, quantity, unit_price, subtotal)
        VALUES (${sale_id}, ${item.product_id}, ${item.quantity}, ${unit_price}, ${subtotal})
      `;
      
      await Bun.sql`UPDATE products SET stock_quantity = stock_quantity - ${item.quantity} WHERE id = ${item.product_id}`;
      
      await Bun.sql`
        INSERT INTO inventory_movements (product_id, movement_type, quantity, reason)
        VALUES (${item.product_id}, 'EXIT', ${item.quantity}, 'VENTA #' || ${sale_id})
      `;
    }
    
    const saleDetails = await Bun.sql`SELECT * FROM sale_items WHERE sale_id = ${sale_id}`;
    return c.json({ ...sale[0], items: saleDetails }, 201);
  } catch (error) {
    console.error("Error en POST /api/sales:", error);
    return c.json({ error: "Error al crear venta" }, 500);
  }
});

// GET todas las ventas
app.get("/api/sales", async (c) => {
  try {
    const sales = await Bun.sql`SELECT * FROM sales ORDER BY sale_date DESC`;
    return c.json(sales);
  } catch (error) {
    console.error("Error en GET /api/sales:", error);
    return c.json({ error: "Error al obtener ventas" }, 500);
  }
});

// GET productos más vendidos
app.get("/api/reports/top-products", async (c) => {
  try {
    const topProducts = await Bun.sql`
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