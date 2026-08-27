import type { BoxOpeningResponse } from '@creatordrop/contracts';

export type BoxOpeningBody = BoxOpeningResponse;
export type FulfillmentStatus = BoxOpeningResponse['opening']['fulfillmentStatus'];

declare const openingIdBrand: unique symbol;
export type OpeningId = string & { readonly [openingIdBrand]: 'OpeningId' };
