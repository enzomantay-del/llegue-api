class Member {
  Member({
    required this.id,
    required this.familyId,
    required this.name,
    required this.role,
    required this.token,
    this.receivesAlerts = true,
  });

  final String id;
  final String familyId;
  final String name;
  final String role; // adult | child
  final String token;
  bool receivesAlerts;

  Map<String, dynamic> toPublicJson() => {
        'id': id,
        'familyId': familyId,
        'name': name,
        'role': role,
        'receivesAlerts': receivesAlerts,
      };

  Map<String, dynamic> toStoreJson() => {
        ...toPublicJson(),
        'token': token,
      };

  factory Member.fromStoreJson(Map<String, dynamic> json) {
    return Member(
      id: json['id'] as String,
      familyId: json['familyId'] as String,
      name: json['name'] as String,
      role: json['role'] as String,
      token: json['token'] as String,
      receivesAlerts: json['receivesAlerts'] as bool? ?? true,
    );
  }
}

class Family {
  Family({
    required this.id,
    required this.inviteCode,
    required this.createdAt,
  });

  final String id;
  final String inviteCode;
  final String createdAt;

  Map<String, dynamic> toJson() => {
        'id': id,
        'inviteCode': inviteCode,
        'createdAt': createdAt,
      };

  factory Family.fromJson(Map<String, dynamic> json) {
    return Family(
      id: json['id'] as String,
      inviteCode: json['inviteCode'] as String,
      createdAt: json['createdAt'] as String,
    );
  }
}

class FamilyEvent {
  FamilyEvent({
    required this.id,
    required this.familyId,
    required this.actorMemberId,
    required this.type,
    required this.title,
    required this.body,
    required this.createdAt,
    this.placeName,
    this.latitude,
    this.longitude,
    this.highPriority = false,
    this.childId,
    this.childName,
  });

  final String id;
  final String familyId;
  final String actorMemberId;
  final String type;
  final String title;
  final String body;
  final String createdAt;
  final String? placeName;
  final double? latitude;
  final double? longitude;
  final bool highPriority;
  final String? childId;
  final String? childName;

  Map<String, dynamic> toJson() => {
        'id': id,
        'familyId': familyId,
        'actorMemberId': actorMemberId,
        'type': type,
        'title': title,
        'body': body,
        'createdAt': createdAt,
        'placeName': placeName,
        'latitude': latitude,
        'longitude': longitude,
        'highPriority': highPriority,
        'childId': childId,
        'childName': childName,
      };

  factory FamilyEvent.fromJson(Map<String, dynamic> json) {
    return FamilyEvent(
      id: json['id'] as String,
      familyId: json['familyId'] as String,
      actorMemberId: json['actorMemberId'] as String,
      type: json['type'] as String,
      title: json['title'] as String,
      body: json['body'] as String,
      createdAt: json['createdAt'] as String,
      placeName: json['placeName'] as String?,
      latitude: (json['latitude'] as num?)?.toDouble(),
      longitude: (json['longitude'] as num?)?.toDouble(),
      highPriority: json['highPriority'] as bool? ?? false,
      childId: json['childId'] as String?,
      childName: json['childName'] as String?,
    );
  }
}
