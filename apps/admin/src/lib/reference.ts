/** Reference data from @jastipkita/core (same source as the API) for pickers. */
import { COUNTRIES, PRODUCT_CATEGORIES } from '@jastipkita/core';

export const COUNTRY_OPTIONS = COUNTRIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.nameId}` }));
export const ORIGIN_COUNTRY_OPTIONS = COUNTRIES.filter((c) => c.origin).map((c) => ({ value: c.code, label: `${c.code} · ${c.nameId}` }));
export const CATEGORY_OPTIONS = PRODUCT_CATEGORIES.map((c) => ({ value: c.code, label: `${c.code} · ${c.nameId}` }));
