-- Owner ids were rewritten in place during the Realmroot cutover. Runtime
-- authorization uses the canonical Realmroot tenant id directly and must not
-- retain a legacy Better Auth owner-to-tenant mapping table.
DROP TABLE IF EXISTS realmroot_identity_mappings;
