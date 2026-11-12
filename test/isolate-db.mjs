/**
 * La suite no puede heredar DATABASE_URL (Neon) ni reponerla desde .env.
 * Importar este módulo antes de levantar la API.
 */
process.env.LLEGUE_TEST = '1';
delete process.env.DATABASE_URL;
