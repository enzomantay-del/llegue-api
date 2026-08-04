import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:uuid/uuid.dart';

import 'models.dart';

class DataStore {
  DataStore(this.file);

  final File file;
  final _uuid = const Uuid();
  final _random = Random.secure();

  final Map<String, Family> families = {};
  final Map<String, Member> membersById = {};
  final Map<String, Member> membersByToken = {};
  final List<FamilyEvent> events = [];
  /// familyId -> { places: [], routines: [], updatedAt: iso }
  final Map<String, Map<String, dynamic>> configs = {};

  Future<void> load() async {
    if (!await file.exists()) {
      await file.parent.create(recursive: true);
      await save();
      return;
    }
    final raw = await file.readAsString();
    if (raw.trim().isEmpty) return;
    final data = jsonDecode(raw) as Map<String, dynamic>;

    for (final item in (data['families'] as List<dynamic>? ?? [])) {
      final family = Family.fromJson(Map<String, dynamic>.from(item as Map));
      families[family.id] = family;
    }
    for (final item in (data['members'] as List<dynamic>? ?? [])) {
      final member =
          Member.fromStoreJson(Map<String, dynamic>.from(item as Map));
      membersById[member.id] = member;
      if (member.token.isNotEmpty && !member.pending) {
        membersByToken[member.token] = member;
      }
    }
    for (final item in (data['events'] as List<dynamic>? ?? [])) {
      events.add(FamilyEvent.fromJson(Map<String, dynamic>.from(item as Map)));
    }
    final configsRaw = data['configs'] as Map<String, dynamic>? ?? {};
    for (final entry in configsRaw.entries) {
      configs[entry.key] = Map<String, dynamic>.from(entry.value as Map);
    }
  }

  Future<void> save() async {
    await file.parent.create(recursive: true);
    final payload = {
      'families': families.values.map((f) => f.toJson()).toList(),
      'members': membersById.values.map((m) => m.toStoreJson()).toList(),
      'events': events.map((e) => e.toJson()).toList(),
      'configs': configs,
    };
    await file.writeAsString(const JsonEncoder.withIndent('  ').convert(payload));
  }

  Future<void> wipeAll() async {
    families.clear();
    membersById.clear();
    membersByToken.clear();
    events.clear();
    configs.clear();
    await save();
  }

  Map<String, dynamic> getConfig(String familyId) {
    return configs[familyId] ??
        {
          'places': <dynamic>[],
          'routines': <dynamic>[],
          'children': <dynamic>[],
          'updatedAt': null,
        };
  }

  Future<Map<String, dynamic>> putConfig({
    required String familyId,
    required List<dynamic> places,
    required List<dynamic> routines,
    List<dynamic> children = const [],
  }) async {
    final existing = configs[familyId];
    final config = {
      'places': places,
      'routines': routines,
      'children': children.isNotEmpty
          ? children
          : (existing?['children'] as List<dynamic>? ?? <dynamic>[]),
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    configs[familyId] = config;
    await save();
    return config;
  }

  String _inviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return List.generate(6, (_) => chars[_random.nextInt(chars.length)]).join();
  }

  String _personalInviteToken() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return List.generate(10, (_) => chars[_random.nextInt(chars.length)]).join();
  }

  Future<Map<String, dynamic>> createFamily({
    required String adminName,
    String familyRole = 'Padre/Madre',
    String birthDate = '',
    String city = '',
  }) async {
    final family = Family(
      id: _uuid.v4(),
      inviteCode: _inviteCode(),
      createdAt: DateTime.now().toUtc().toIso8601String(),
    );
    families[family.id] = family;

    final admin = Member(
      id: _uuid.v4(),
      familyId: family.id,
      name: adminName.trim().isEmpty ? 'Adulto' : adminName.trim(),
      role: 'adult',
      token: _uuid.v4(),
      receivesAlerts: true,
      familyRole: familyRole.trim().isEmpty ? 'Padre/Madre' : familyRole.trim(),
      birthDate: birthDate,
      city: city,
    );
    membersById[admin.id] = admin;
    membersByToken[admin.token] = admin;
    await save();

    return {
      'family': family.toJson(),
      'member': admin.toPublicJson(),
      'token': admin.token,
    };
  }

  Future<Map<String, dynamic>> createPendingInvite({
    required Member actor,
    required String name,
    required String role,
    String familyRole = '',
    String birthDate = '',
  }) async {
    if (actor.role != 'adult') {
      throw StateError('Solo un adulto puede invitar');
    }
    final safeRole = role == 'child' ? 'child' : 'adult';
    final inviteToken = _personalInviteToken();
    final member = Member(
      id: _uuid.v4(),
      familyId: actor.familyId,
      name: name.trim().isEmpty
          ? (safeRole == 'child' ? 'Hijo/a' : 'Familiar')
          : name.trim(),
      role: safeRole,
      token: '',
      receivesAlerts: safeRole == 'adult',
      familyRole: familyRole.trim().isEmpty
          ? (safeRole == 'child' ? 'Hijo/a' : 'Familiar')
          : familyRole.trim(),
      birthDate: birthDate,
      pending: true,
      inviteToken: inviteToken,
    );
    membersById[member.id] = member;
    await save();
    return {
      'member': member.toPublicJson(),
      'inviteToken': inviteToken,
    };
  }

  Member? memberByInviteToken(String token) {
    final normalized = token.trim().toUpperCase();
    for (final m in membersById.values) {
      if (m.inviteToken.toUpperCase() == normalized) return m;
    }
    return null;
  }

  Future<Map<String, dynamic>> claimInvite({required String inviteToken}) async {
    final member = memberByInviteToken(inviteToken);
    if (member == null) {
      throw StateError('Invitación no encontrada');
    }
    if (!member.pending && member.token.isNotEmpty) {
      throw StateError('Esta invitación ya fue usada');
    }
    final family = families[member.familyId];
    if (family == null) {
      throw StateError('Familia no encontrada');
    }
    member.pending = false;
    member.token = _uuid.v4();
    membersByToken[member.token] = member;
    await save();
    return {
      'family': family.toJson(),
      'member': member.toPublicJson(),
      'token': member.token,
    };
  }

  Future<Map<String, dynamic>> joinFamily({
    required String code,
    required String name,
    required String role,
  }) async {
    final normalized = code.trim().toUpperCase();
    Family? family;
    for (final item in families.values) {
      if (item.inviteCode == normalized) {
        family = item;
        break;
      }
    }
    if (family == null) {
      throw StateError('Código inválido');
    }

    final safeRole = role == 'child' ? 'child' : 'adult';
    final member = Member(
      id: _uuid.v4(),
      familyId: family.id,
      name: name.trim().isEmpty ? (safeRole == 'child' ? 'Hijo/a' : 'Adulto') : name.trim(),
      role: safeRole,
      token: _uuid.v4(),
      receivesAlerts: safeRole == 'adult',
    );
    membersById[member.id] = member;
    membersByToken[member.token] = member;
    await save();

    return {
      'family': family.toJson(),
      'member': member.toPublicJson(),
      'token': member.token,
    };
  }

  List<Member> membersOf(String familyId) {
    return membersById.values.where((m) => m.familyId == familyId).toList();
  }

  Future<FamilyEvent> addEvent({
    required Member actor,
    required String type,
    required String title,
    required String body,
    String? placeName,
    double? latitude,
    double? longitude,
    bool highPriority = false,
    String? childId,
    String? childName,
  }) async {
    final event = FamilyEvent(
      id: _uuid.v4(),
      familyId: actor.familyId,
      actorMemberId: actor.id,
      type: type,
      title: title,
      body: body,
      createdAt: DateTime.now().toUtc().toIso8601String(),
      placeName: placeName,
      latitude: latitude,
      longitude: longitude,
      highPriority: highPriority,
      childId: childId,
      childName: childName,
    );
    events.add(event);
    // Mantener últimos 500 eventos.
    if (events.length > 500) {
      events.removeRange(0, events.length - 500);
    }
    await save();
    return event;
  }

  List<FamilyEvent> eventsSince({
    required String familyId,
    required DateTime since,
    required String viewerMemberId,
  }) {
    return events.where((e) {
      if (e.familyId != familyId) return false;
      if (e.actorMemberId == viewerMemberId) return false;
      final created = DateTime.tryParse(e.createdAt);
      if (created == null) return false;
      return created.isAfter(since);
    }).toList()
      ..sort((a, b) => a.createdAt.compareTo(b.createdAt));
  }
}
