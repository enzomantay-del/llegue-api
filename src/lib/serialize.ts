import type { Device, Family, Invitation, User } from '@prisma/client';

export function userPublic(user: User) {
  return {
    id: user.id,
    familyId: user.familyId,
    role: user.role,
    name: user.name,
    phone: user.phone,
    birthDate: user.birthDate,
    relationshipLabel: user.relationshipLabel,
    createdAt: user.createdAt,
    hasPin: Boolean(user.pinHash),
  };
}

export function familyPublic(family: Family) {
  return {
    id: family.id,
    name: family.name,
    createdAt: family.createdAt,
  };
}

export function invitationPublic(inv: Invitation, familyName?: string) {
  return {
    id: inv.id,
    familyId: inv.familyId,
    familyName: familyName ?? null,
    role: inv.role,
    nameHint: inv.nameHint,
    code: inv.code,
    deepLinkToken: inv.deepLinkToken,
    status: inv.status,
    expiresAt: inv.expiresAt,
    requiresPin: Boolean(inv.pinHash) && inv.role === 'kid',
  };
}

export function devicePublic(device: Device) {
  return {
    id: device.id,
    platform: device.platform,
    locationPermission: device.locationPermission,
    notificationsPermission: device.notificationsPermission,
    permissionsCompletedAt: device.permissionsCompletedAt,
    lastSeenAt: device.lastSeenAt,
    batteryLevel: device.batteryLevel,
  };
}
