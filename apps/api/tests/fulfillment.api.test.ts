import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import type { FulfillmentContract } from '@creatordrop/contracts';

import type { FulfillmentService } from '../src/modules/fulfillment/fulfillment.service.js';
import { createTestApp } from './support/test-app.js';

const creatorId = '019d0000-0000-7000-8000-000000000002';
const fulfillmentId = '019d0000-0000-7000-8000-000000000003';
const poolId = '019d0000-0000-7000-8000-000000000004';
const actorUserId = '019c0000-0000-7000-8000-000000000001';

const fulfillment: FulfillmentContract = {
  createdAt: '2026-08-31T12:00:00.000Z',
  creatorId,
  deliveredAt: null,
  deliveryData: { available: true, expiresAt: null, redactedAt: null },
  events: [],
  fulfilledAt: null,
  fulfillmentType: 'physical',
  id: fulfillmentId,
  openingId: '019d0000-0000-7000-8000-000000000005',
  revision: 2,
  reward: {
    imageUrl: null,
    name: 'Physical reward',
    rewardId: '019d0000-0000-7000-8000-000000000006',
    rewardVersionId: '019d0000-0000-7000-8000-000000000007',
  },
  shippedAt: null,
  state: 'ready_to_ship',
  updatedAt: '2026-08-31T12:01:00.000Z',
};

const serviceWith = (overrides: Partial<FulfillmentService>): FulfillmentService => {
  const unhandled = (): Promise<never> => Promise.reject(new Error('Unhandled fulfillment call.'));
  return {
    applyCreatorAction: unhandled,
    getCreatorDeliveryData: unhandled,
    getCreatorFulfillment: unhandled,
    getUserDeliveryData: unhandled,
    getUserFulfillment: unhandled,
    listCreatorFulfillments: unhandled,
    listUserFulfillments: unhandled,
    redactCreatorDeliveryData: unhandled,
    redactUserDeliveryData: unhandled,
    restock: unhandled,
    submitAddress: unhandled,
    ...overrides,
  };
};

describe('fulfillment API boundary', () => {
  it('derives the winning user and accepts only the minimized address shape', async () => {
    const submitAddress = vi
      .fn<FulfillmentService['submitAddress']>()
      .mockResolvedValue({ fulfillment, replayed: false });
    const response = await request(
      createTestApp({ fulfillmentService: serviceWith({ submitAddress }) }),
    )
      .post(`/v1/me/fulfillments/${fulfillmentId}/address`)
      .set('Idempotency-Key', 'address-action-1')
      .set('If-Match', '"1"')
      .send({
        addressLine1: '123 Example Street',
        addressLine2: null,
        city: 'Toronto',
        country: 'ca',
        postalCode: 'M5V 2T6',
        recipientName: 'Synthetic Recipient',
        region: 'ON',
      });
    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(submitAddress.mock.calls[0]?.[0]).toMatchObject({
      actionKey: 'address-action-1',
      actorUserId,
      expectedRevision: 1,
      fulfillmentId,
      address: { country: 'CA' },
    });
    expect(JSON.stringify(response.body)).not.toContain(actorUserId);
  });

  it('passes only typed creator commands and creator scope to the service', async () => {
    const applyCreatorAction = vi
      .fn<FulfillmentService['applyCreatorAction']>()
      .mockResolvedValue({ fulfillment, replayed: false });
    const response = await request(
      createTestApp({ fulfillmentService: serviceWith({ applyCreatorAction }) }),
    )
      .post(
        `/v1/creators/${creatorId.toUpperCase()}/dashboard/fulfillments/${fulfillmentId.toUpperCase()}/actions`,
      )
      .set('Idempotency-Key', 'creator-action-1')
      .set('If-Match', '2')
      .send({ action: 'mark_shipped' });
    expect(response.status).toBe(200);
    expect(applyCreatorAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { action: 'mark_shipped' },
        actorUserId,
        creatorId,
        fulfillmentId,
      }),
    );
  });

  it('requires a canonical positive quantity and idempotency key for manual restock', async () => {
    const restock = vi.fn<FulfillmentService['restock']>().mockResolvedValue({
      inventoryPool: { availableQuantity: '4', id: poolId, initialQuantity: '1' },
      replayed: false,
      restockEvent: {
        createdAt: '2026-08-31T12:00:00.000Z',
        id: '019d0000-0000-7000-8000-000000000008',
        quantityAdded: '3',
      },
    });
    const app = createTestApp({ fulfillmentService: serviceWith({ restock }) });
    const accepted = await request(app)
      .post(`/v1/creators/${creatorId}/dashboard/inventory-pools/${poolId}/restocks`)
      .set('Idempotency-Key', 'restock-action-1')
      .send({ quantity: '3' });
    expect(accepted.status).toBe(201);
    expect(restock).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId, creatorId, poolId, quantity: 3n }),
    );
    const rejected = await request(app)
      .post(`/v1/creators/${creatorId}/dashboard/inventory-pools/${poolId}/restocks`)
      .set('Idempotency-Key', 'restock-action-2')
      .send({ automaticResume: true, quantity: '3' });
    expect(rejected.status).toBe(400);
    expect(restock).toHaveBeenCalledTimes(1);
  });
});
