import 'dart:convert';

import 'package:shelf/shelf.dart';
import 'package:shelf_router/shelf_router.dart';

import 'models.dart';
import 'store.dart';

class LlegueApi {
  LlegueApi(this.store);

  final DataStore store;

  Router get router {
    final app = Router();

    app.get('/health', (Request request) {
      return _json({'ok': true, 'service': 'llegue-backend'});
    });

    app.post('/v1/families', (Request request) async {
      final body = await _body(request);
      final result = await store.createFamily(
        adminName: (body['name'] as String?) ?? 'Adulto',
      );
      return _json(result, status: 201);
    });

    app.post('/v1/families/join', (Request request) async {
      final body = await _body(request);
      try {
        final result = await store.joinFamily(
          code: (body['code'] as String?) ?? '',
          name: (body['name'] as String?) ?? '',
          role: (body['role'] as String?) ?? 'adult',
        );
        return _json(result, status: 201);
      } catch (e) {
        return _error(e.toString().replaceFirst('Bad state: ', ''), status: 404);
      }
    });

    app.get('/v1/me', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final family = store.families[member.familyId];
      if (family == null) return _error('Familia no encontrada', status: 404);
      return _json({
        'family': family.toJson(),
        'member': member.toPublicJson(),
        'members': store
            .membersOf(member.familyId)
            .map((m) => m.toPublicJson())
            .toList(),
      });
    });

    app.patch('/v1/me', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final body = await _body(request);
      if (body.containsKey('receivesAlerts') && member.role == 'adult') {
        member.receivesAlerts = body['receivesAlerts'] == true;
      }
      if (body['name'] is String && (body['name'] as String).trim().isNotEmpty) {
        // Name is final in model - recreate would be heavier; skip rename for now
      }
      await store.save();
      return _json({'member': member.toPublicJson()});
    });

    app.post('/v1/events', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      final body = await _body(request);
      final event = await store.addEvent(
        actor: member,
        type: (body['type'] as String?) ?? 'info',
        title: (body['title'] as String?) ?? 'Aviso',
        body: (body['body'] as String?) ?? '',
        placeName: body['placeName'] as String?,
        latitude: (body['latitude'] as num?)?.toDouble(),
        longitude: (body['longitude'] as num?)?.toDouble(),
        highPriority: body['highPriority'] == true,
        childId: body['childId'] as String?,
        childName: body['childName'] as String?,
      );
      return _json({'event': event.toJson()}, status: 201);
    });

    app.get('/v1/events', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();

      // Solo adultos con avisos activos reciben el feed (los hijos también pueden
      // leer para sync de UI, pero el cliente filtra).
      final sinceParam = request.url.queryParameters['since'];
      final since = DateTime.tryParse(sinceParam ?? '') ??
          DateTime.now().toUtc().subtract(const Duration(minutes: 30));

      final list = store.eventsSince(
        familyId: member.familyId,
        since: since,
        viewerMemberId: member.id,
      );

      return _json({'events': list.map((e) => e.toJson()).toList()});
    });

    app.get('/v1/config', (Request request) {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      return _json({'config': store.getConfig(member.familyId)});
    });

    app.put('/v1/config', (Request request) async {
      final member = _auth(request);
      if (member == null) return _unauthorized();
      // Cualquier miembro del círculo puede actualizar la config compartida.
      final body = await _body(request);
      final places = body['places'] as List<dynamic>? ?? [];
      final routines = body['routines'] as List<dynamic>? ?? [];
      final children = body['children'] as List<dynamic>? ?? [];
      final config = await store.putConfig(
        familyId: member.familyId,
        places: places,
        routines: routines,
        children: children,
      );
      return _json({'config': config});
    });

    return app;
  }

  Member? _auth(Request request) {
    final header = request.headers['authorization'];
    if (header == null || !header.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    final token = header.substring(7).trim();
    return store.membersByToken[token];
  }

  Future<Map<String, dynamic>> _body(Request request) async {
    final raw = await request.readAsString();
    if (raw.trim().isEmpty) return {};
    return Map<String, dynamic>.from(jsonDecode(raw) as Map);
  }

  Response _json(Object data, {int status = 200}) {
    return Response(
      status,
      body: jsonEncode(data),
      headers: {'content-type': 'application/json; charset=utf-8'},
    );
  }

  Response _error(String message, {int status = 400}) {
    return _json({'error': message}, status: status);
  }

  Response _unauthorized() => _error('No autorizado', status: 401);
}
