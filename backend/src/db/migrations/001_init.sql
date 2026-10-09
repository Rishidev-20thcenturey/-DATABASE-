-- Food delivery platform: initial schema.
-- Money is always stored as integer minor units (paise for INR).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  email         TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'CUSTOMER'
                CHECK (role IN ('CUSTOMER', 'RESTAURANT_OWNER', 'COURIER', 'ADMIN')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Emails are stored lower-cased and trimmed by the application; the unique index is case-sensitive on that normalized value.
CREATE UNIQUE INDEX users_email_key ON users (email);

CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by UUID REFERENCES refresh_tokens(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label           TEXT,
  recipient_name  TEXT NOT NULL,
  recipient_phone TEXT NOT NULL,
  line1           TEXT NOT NULL,
  landmark        TEXT,
  city            TEXT NOT NULL,
  state           TEXT NOT NULL,
  postal_code     TEXT NOT NULL CHECK (postal_code ~ '^[0-9]{6}$'),
  country         TEXT NOT NULL DEFAULT 'IN',
  latitude        NUMERIC(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude       NUMERIC(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  instructions    TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX addresses_user_idx ON addresses (user_id);
-- At most one default address per customer.
CREATE UNIQUE INDEX addresses_one_default_idx ON addresses (user_id) WHERE is_default;

CREATE TABLE restaurants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id             UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  name                 TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 150),
  description          TEXT,
  logo_url             TEXT,
  cover_url            TEXT,
  cuisines             TEXT[] NOT NULL DEFAULT '{}',
  address_line         TEXT NOT NULL,
  city                 TEXT NOT NULL,
  state                TEXT NOT NULL,
  postal_code          TEXT NOT NULL CHECK (postal_code ~ '^[0-9]{6}$'),
  latitude             NUMERIC(9, 6),
  longitude            NUMERIC(9, 6),
  opens_at             TIME NOT NULL DEFAULT '09:00',
  closes_at            TIME NOT NULL DEFAULT '23:00',
  min_order_minor      INTEGER NOT NULL DEFAULT 0 CHECK (min_order_minor >= 0),
  delivery_fee_minor   INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_minor >= 0),
  tax_bps              INTEGER NOT NULL DEFAULT 0 CHECK (tax_bps BETWEEN 0 AND 10000),
  prep_minutes         INTEGER NOT NULL DEFAULT 20 CHECK (prep_minutes >= 0),
  delivery_minutes     INTEGER NOT NULL DEFAULT 30 CHECK (delivery_minutes >= 0),
  status               TEXT NOT NULL DEFAULT 'PENDING_APPROVAL'
                       CHECK (status IN ('PENDING_APPROVAL', 'ACTIVE', 'SUSPENDED')),
  is_accepting_orders  BOOLEAN NOT NULL DEFAULT true,
  rating_average       NUMERIC(3, 2) NOT NULL DEFAULT 0,
  rating_count         INTEGER NOT NULL DEFAULT 0 CHECK (rating_count >= 0),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX restaurants_status_idx ON restaurants (status);
CREATE INDEX restaurants_owner_idx ON restaurants (owner_id);
CREATE INDEX restaurants_postal_idx ON restaurants (postal_code);
CREATE INDEX restaurants_cuisines_idx ON restaurants USING GIN (cuisines);

CREATE TABLE menu_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description   TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menu_categories_restaurant_idx ON menu_categories (restaurant_id, display_order);

CREATE TABLE menu_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  category_id   UUID NOT NULL REFERENCES menu_categories(id) ON DELETE RESTRICT,
  name          TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 150),
  description   TEXT,
  image_url     TEXT,
  price_minor   INTEGER NOT NULL CHECK (price_minor >= 0),
  is_veg        BOOLEAN,
  dietary_labels TEXT[] NOT NULL DEFAULT '{}',
  is_available  BOOLEAN NOT NULL DEFAULT true,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX menu_items_restaurant_idx ON menu_items (restaurant_id, is_active, is_available);
CREATE INDEX menu_items_category_idx ON menu_items (category_id);

CREATE TABLE carts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID REFERENCES restaurants(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cart_items (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id      UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
  quantity     INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cart_id, menu_item_id)
);

CREATE TABLE orders (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number          TEXT NOT NULL UNIQUE,
  customer_id           UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  restaurant_id         UUID NOT NULL REFERENCES restaurants(id) ON DELETE RESTRICT,
  status                TEXT NOT NULL DEFAULT 'PENDING_RESTAURANT_CONFIRMATION'
                        CHECK (status IN (
                          'PENDING_RESTAURANT_CONFIRMATION', 'REJECTED', 'CANCELLED',
                          'CONFIRMED', 'PREPARING', 'READY_FOR_PICKUP',
                          'PICKED_UP', 'OUT_FOR_DELIVERY', 'DELIVERED')),
  payment_method        TEXT NOT NULL CHECK (payment_method IN ('COD')),
  payment_status        TEXT NOT NULL DEFAULT 'COD_PENDING'
                        CHECK (payment_status IN ('COD_PENDING', 'COD_COLLECTED', 'NOT_CHARGED')),
  delivery_address      JSONB NOT NULL,
  customer_note         TEXT,
  currency              TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  subtotal_minor        INTEGER NOT NULL CHECK (subtotal_minor >= 0),
  delivery_fee_minor    INTEGER NOT NULL CHECK (delivery_fee_minor >= 0),
  tax_minor             INTEGER NOT NULL CHECK (tax_minor >= 0),
  discount_minor        INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor           INTEGER NOT NULL CHECK (total_minor >= 0),
  idempotency_key       TEXT,
  request_hash          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at          TIMESTAMPTZ,
  delivered_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  cancel_reason         TEXT,
  CHECK (total_minor = subtotal_minor + delivery_fee_minor + tax_minor - discount_minor)
);
CREATE INDEX orders_customer_idx ON orders (customer_id, created_at DESC);
CREATE INDEX orders_restaurant_idx ON orders (restaurant_id, status, created_at DESC);
-- Duplicate-checkout protection: one order per customer per Idempotency-Key.
CREATE UNIQUE INDEX orders_idempotency_idx ON orders (customer_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE order_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  menu_item_id      UUID REFERENCES menu_items(id) ON DELETE SET NULL,
  item_name         TEXT NOT NULL,
  unit_price_minor  INTEGER NOT NULL CHECK (unit_price_minor >= 0),
  quantity          INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 50),
  line_total_minor  INTEGER NOT NULL CHECK (line_total_minor >= 0),
  CHECK (line_total_minor = unit_price_minor * quantity)
);
CREATE INDEX order_items_order_idx ON order_items (order_id);

CREATE TABLE order_status_history (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  actor_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, created_at);

CREATE TABLE deliveries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  courier_id    UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status        TEXT NOT NULL DEFAULT 'ASSIGNED' CHECK (status IN ('ASSIGNED', 'COMPLETED', 'CANCELLED')),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  picked_up_at  TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_courier_idx ON deliveries (courier_id, status);

CREATE TABLE reviews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  customer_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT CHECK (comment IS NULL OR char_length(comment) <= 1000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reviews_restaurant_idx ON reviews (restaurant_id, created_at DESC);

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  details     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
