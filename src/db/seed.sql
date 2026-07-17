-- Seed default admin user
-- Password: admin123 (hashed with bcryptjs)
INSERT INTO users (name, email, password_hash, role, status)
VALUES (
    'Admin',
    'admin@complianceguard.com',
    '$2a$10$8K1p/a0dL1LXMc.0zK3wGOvFCPmDvFq3mJq3v3h3h3h3h3h3h3h3',
    'Admin',
    'Active'
);
