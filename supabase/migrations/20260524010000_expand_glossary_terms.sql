insert into glossary_terms (
  slug,
  term,
  korean_term,
  definition,
  jurisdiction,
  related_tags
) values
(
  'admissibility',
  'Admissibility / Zulassigkeit / Recevabilite',
  '적법요건',
  '헌법재판기관이 본안 판단에 들어가기 전에 청구권자, 기간, 대상, 보충성, 권리보호이익 같은 절차 요건을 충족했는지 보는 단계다.',
  null,
  array['적법요건', '각하', '불수리']
),
(
  'annulment',
  'Annulment / Annulation',
  '취소',
  '선거, 행정행위, 법률 조항 등의 효력을 헌법 또는 법률 기준에 맞지 않는다는 이유로 제거하는 결론이다.',
  null,
  array['취소', '무효', '선거무효']
),
(
  'as-applied-challenge',
  'As-applied challenge',
  '적용상 위헌 주장',
  '법률 자체가 모든 경우에 위헌이라는 주장이 아니라, 특정 사실관계나 당사자에게 적용되는 방식이 헌법에 어긋난다는 주장이다.',
  'United States',
  array['As-applied challenge', '위헌심사']
),
(
  'bverfgg',
  'Bundesverfassungsgerichtsgesetz',
  '연방헌법재판소법',
  '독일 연방헌법재판소의 관할, 절차, 재판부 구성, 결정 방식 등을 정하는 법률이다.',
  'Germany',
  array['BVerfGG', '연방헌법재판소법']
),
(
  'bloc-de-constitutionnalite',
  'Bloc de constitutionnalite',
  '헌법성 블록',
  '프랑스 헌법위원회가 합헌성 심사의 기준으로 삼는 1958년 헌법, 1789년 인권선언, 1946년 헌법 전문 등 헌법적 규범 묶음이다.',
  'France',
  array['Bloc de constitutionnalite', '헌법성 블록', 'Déclaration de 1789']
),
(
  'campaign-accounts',
  'Comptes de campagne',
  '선거회계',
  '후보자 또는 선거 캠프가 선거운동 수입과 지출을 기록해 제출하는 회계 자료로, 프랑스 선거 사건에서 당선 무효나 피선거권 제한과 연결될 수 있다.',
  'France',
  array['회계보고서', '선거비용', 'Comptes de campagne']
),
(
  'certiorari',
  'Writ of certiorari',
  '사건심리명령',
  '미국 연방대법원이 하급심 사건을 심리 대상으로 받아들일지 결정하는 절차적 장치다.',
  'United States',
  array['Certiorari', 'Supreme Court']
),
(
  'cnccfp',
  'Commission nationale des comptes de campagne et des financements politiques',
  '프랑스 선거회계·정치자금위원회',
  '프랑스 선거비용과 정치자금 회계를 심사하는 기관으로, 선거비용 초과나 회계보고서 문제를 헌법위원회에 연결하는 역할을 한다.',
  'France',
  array['CNCCFP', 'Commission nationale des comptes de campagne et des financements politiques']
),
(
  'code-electoral',
  'Code electoral',
  '프랑스 선거법전',
  '프랑스 선거 절차, 선거비용, 후보자 자격, 선거무효 판단의 기준이 되는 법전이다.',
  'France',
  array['Code électoral', '선거법']
),
(
  'compelled-speech',
  'Compelled speech',
  '강제표현',
  '국가가 개인이나 단체에게 특정 메시지를 말하거나 표시하도록 강제하는 상황으로, 미국 수정헌법 제1조 사건에서 자주 문제 된다.',
  'United States',
  array['Compelled speech', 'First Amendment']
),
(
  'concrete-review',
  'Konkrete Normenkontrolle',
  '구체적 규범통제',
  '법원이 재판 중 적용해야 할 법률의 위헌성이 문제 된 경우, 독일 연방헌법재판소에 심사를 제청하는 절차다.',
  'Germany',
  array['Konkrete Normenkontrolle', '위헌법률심판']
),
(
  'conseil-constitutionnel',
  'Conseil constitutionnel',
  '프랑스 헌법위원회',
  '프랑스의 헌법재판기관으로, 사전적 법률심사, QPC, 대통령·의회 선거 관련 심사 등을 담당한다.',
  'France',
  array['Conseil constitutionnel', '헌법위원회']
),
(
  'constitutional-complaint',
  'Verfassungsbeschwerde',
  '헌법소원',
  '독일에서 공권력 행사로 기본권이 침해되었다고 주장하는 개인 등이 연방헌법재판소에 제기할 수 있는 권리구제 절차다.',
  'Germany',
  array['Verfassungsbeschwerde', '헌법소원', '기본권']
),
(
  'constitutional-review',
  'Constitutional review',
  '헌법심사',
  '법률, 국가작용, 선거 절차 등이 헌법에 맞는지 헌법재판기관 또는 법원이 판단하는 절차와 판단 작용이다.',
  null,
  array['헌법심사', '위헌심사', '헌법재판']
),
(
  'constitution-1958',
  'Constitution du 4 octobre 1958',
  '1958년 프랑스 헌법',
  '프랑스 제5공화국의 헌법으로, 헌법위원회의 권한과 법률심사, QPC의 근거 조항을 포함한다.',
  'France',
  array['Constitution', '1958년 헌법', 'Article 61', 'Article 61-1']
),
(
  'declaration-1789',
  'Declaration des droits de l''homme et du citoyen de 1789',
  '1789년 인간과 시민의 권리선언',
  '프랑스 헌법성 블록의 핵심 문서로, 자유, 평등, 재산권, 죄형법정주의 등 여러 기본권 심사의 기준이 된다.',
  'France',
  array['Déclaration des droits de l''homme et du citoyen de 1789', 'Déclaration de 1789']
),
(
  'defense-rights',
  'Rights of defence / Droits de la defense',
  '방어권',
  '형사·징계·행정 절차에서 당사자가 자신에게 불리한 주장과 증거에 대응할 기회를 보장받는 권리다.',
  null,
  array['방어권', '적법절차']
),
(
  'due-process',
  'Due process',
  '적법절차',
  '국가가 생명, 자유, 재산에 영향을 미칠 때 공정한 절차와 법적 근거를 갖추어야 한다는 미국 헌법 원칙이다.',
  'United States',
  array['Due Process', 'Fifth Amendment', 'Fourteenth Amendment', '적법절차']
),
(
  'election-nullification',
  'Election annulment',
  '선거무효',
  '선거 절차의 중대한 위법이나 결과에 영향을 미친 하자를 이유로 선거 결과의 효력을 부정하는 판단이다.',
  null,
  array['선거무효', '선거 무효', 'Annulation']
),
(
  'electoral-complaint',
  'Wahlprufungsbeschwerde',
  '선거심사청구',
  '독일에서 연방의회 선거의 유효성 심사와 관련해 연방헌법재판소에 제기되는 절차다.',
  'Germany',
  array['Wahlprüfungsbeschwerde', '선거심사']
),
(
  'equal-protection',
  'Equal Protection Clause',
  '평등보호 조항',
  '미국 수정헌법 제14조의 조항으로, 주가 사람을 불합리하게 차별하지 않아야 한다는 평등심사의 근거다.',
  'United States',
  array['Equal Protection', 'Fourteenth Amendment', '평등']
),
(
  'equality-principle',
  'Equality principle',
  '평등원칙',
  '같은 것은 같게, 다른 것은 다르게 취급해야 하며 차별에는 합리적 이유나 더 엄격한 정당화가 필요하다는 헌법 원칙이다.',
  null,
  array['평등원칙', '평등 원칙', 'Gleichheitssatz']
),
(
  'facial-challenge',
  'Facial challenge',
  '문면 위헌 주장',
  '특정 적용 사례가 아니라 법률 문언 자체가 헌법에 어긋난다고 다투는 미국 헌법소송의 주장 방식이다.',
  'United States',
  array['Facial challenge', '위헌심사']
),
(
  'fifth-amendment',
  'Fifth Amendment',
  '수정헌법 제5조',
  '연방정부에 대한 적법절차, 자기부죄거부, 이중처벌 금지, 수용보상 등 여러 권리 보장의 근거가 되는 미국 헌법 조항이다.',
  'United States',
  array['Fifth Amendment', 'Due Process']
),
(
  'first-amendment',
  'First Amendment',
  '수정헌법 제1조',
  '표현, 언론, 종교, 집회, 청원의 자유를 보장하는 미국 헌법 조항이다.',
  'United States',
  array['First Amendment', '표현의 자유', 'Free Speech']
),
(
  'fourteenth-amendment',
  'Fourteenth Amendment',
  '수정헌법 제14조',
  '주에 대한 적법절차와 평등보호 원칙의 핵심 근거가 되는 미국 헌법 조항이다.',
  'United States',
  array['Fourteenth Amendment', 'Equal Protection', 'Due Process']
),
(
  'freedom-of-expression',
  'Freedom of expression / Meinungsfreiheit / Liberte d''expression',
  '표현의 자유',
  '의견, 정보, 사상, 정치적 표현을 자유롭게 형성하고 전달할 수 있는 기본권으로, 민주적 의사형성의 핵심 조건이다.',
  null,
  array['표현의 자유', 'Free Speech', 'Meinungsfreiheit']
),
(
  'grundgesetz',
  'Grundgesetz',
  '독일 기본법',
  '독일 연방공화국의 헌법으로, 기본권과 국가조직, 연방질서, 헌법재판의 기준을 담고 있다.',
  'Germany',
  array['Grundgesetz', '독일 기본법']
),
(
  'human-dignity',
  'Menschenwurde / Human dignity',
  '인간의 존엄',
  '인간을 단순한 수단으로 취급해서는 안 된다는 독일 기본법 제1조의 핵심 가치이자 여러 기본권 해석의 출발점이다.',
  'Germany',
  array['Menschenwürde', 'Human dignity', '독일 기본법']
),
(
  'inadmissibility',
  'Inadmissibility / Irrecevabilite',
  '각하',
  '청구가 기간, 권리보호이익, 보충성, 관할 등 절차 요건을 충족하지 못해 본안 판단 없이 배척되는 결론이다.',
  null,
  array['각하', '적법요건']
),
(
  'ineligibility',
  'Ineligibilite',
  '피선거권 박탈',
  '선거법 위반, 회계보고 문제, 법정 요건 미충족 등으로 일정 기간 선거에 후보자로 나설 자격을 제한하는 제재다.',
  'France',
  array['피선거권 박탈', '피선거권', 'Inéligibilité']
),
(
  'interim-measures',
  'Interim measures / Einstweilige Anordnung',
  '가처분',
  '본안 결정 전 중대한 손해를 막거나 현상 유지를 위해 잠정적으로 명령하는 절차다.',
  null,
  array['가처분', 'Einstweilige Anordnung']
),
(
  'intermediate-scrutiny',
  'Intermediate scrutiny',
  '중간심사',
  '미국 헌법심사에서 중요한 정부 이익과 그 이익에 실질적으로 관련된 수단을 요구하는 심사 강도다.',
  'United States',
  array['Intermediate scrutiny', '심사기준']
),
(
  'jurisdiction',
  'Jurisdiction / Competence',
  '관할권',
  '특정 기관이나 법원이 어떤 사건을 심리하고 판단할 수 있는 권한 범위를 뜻한다.',
  null,
  array['관할권', 'Competence']
),
(
  'mootness',
  'Mootness',
  '소의 이익 소멸',
  '미국 연방법원에서 분쟁이 더 이상 현실적 의미를 갖지 않아 법원이 판단할 수 없게 되는 사법심사 제한 원칙이다.',
  'United States',
  array['Mootness', 'Article III']
),
(
  'non-admission',
  'Non-admission / Nichtannahme',
  '불수리',
  '헌법재판기관이 사건을 본안 심리 대상으로 받아들이지 않는 결정으로, 독일 헌법소원 등에서 자주 보인다.',
  'Germany',
  array['불수리', 'Nichtannahme', '헌법소원']
),
(
  'organic-law',
  'Loi organique',
  '조직법',
  '프랑스에서 헌법이 예정한 국가기관 구성과 권한, 선거·의회 운영 등을 구체화하는 특별한 법률 유형이다.',
  'France',
  array['Loi organique', '조직법']
),
(
  'organ-dispute',
  'Organstreitverfahren',
  '기관쟁의',
  '독일에서 연방기관 또는 그 일부가 헌법상 권한과 의무를 둘러싸고 다투는 헌법재판 절차다.',
  'Germany',
  array['Organstreitverfahren', '기관쟁의']
),
(
  'overbreadth',
  'Overbreadth doctrine',
  '과잉광범성 원칙',
  '미국 표현의 자유 사건에서 법률이 금지할 수 있는 영역을 넘어 보호되는 표현까지 지나치게 넓게 제한할 때 문제 되는 원칙이다.',
  'United States',
  array['Overbreadth', 'First Amendment']
),
(
  'political-finance',
  'Political finance',
  '정치자금',
  '정당, 후보자, 선거운동의 자금 조달과 지출에 관한 규율 영역으로, 선거 공정성과 표현·참여의 자유가 함께 문제 된다.',
  null,
  array['정치자금', '선거비용', 'Political finance']
),
(
  'prior-restraint',
  'Prior restraint',
  '사전억제',
  '표현이 이루어지기 전에 국가가 허가, 금지, 검열로 표현을 막는 조치로, 미국 수정헌법 제1조상 특히 엄격하게 심사된다.',
  'United States',
  array['Prior restraint', 'First Amendment', '표현의 자유']
),
(
  'property-right',
  'Property right',
  '재산권',
  '재산의 사용, 수익, 처분에 대한 헌법상 보호로, 수용, 규제, 조세, 몰수 사건에서 제한의 정당성이 문제 된다.',
  null,
  array['재산권', 'Property', 'Fifth Amendment']
),
(
  'proportionality',
  'Proportionality',
  '비례원칙',
  '기본권 제한이 목적의 정당성, 수단의 적합성, 최소침해성, 법익균형을 충족해야 한다는 심사 구조다.',
  null,
  array['비례원칙', 'Proportionality']
),
(
  'qpc',
  'Question prioritaire de constitutionnalite',
  '우선적 위헌심사절차',
  '프랑스에서 재판 계속 중 법률 조항의 헌법합치성을 사후적으로 다투는 절차다.',
  'France',
  array['QPC', 'Article 61-1', '우선적 위헌심사']
),
(
  'rational-basis-review',
  'Rational basis review',
  '합리성 심사',
  '미국 헌법심사에서 정부 목적이 정당하고 수단이 그 목적과 합리적으로 관련되면 통과하는 가장 완화된 심사 기준이다.',
  'United States',
  array['Rational basis', 'Equal Protection']
),
(
  'reserve-dinterpretation',
  'Reserve d''interpretation',
  '합헌적 해석유보',
  '프랑스 헌법위원회가 법률 조항을 특정한 방식으로 해석하는 한 합헌이라고 선언하는 판단 방식이다.',
  'France',
  array['Réserve d''interprétation', '합헌적 해석']
),
(
  'right-to-be-heard',
  'Rechtliches Gehor',
  '진술청취권',
  '법원이 당사자의 주장과 의견을 들을 기회를 보장해야 한다는 독일 기본권적 절차 보장이다.',
  'Germany',
  array['Rechtliches Gehör', '청문권', '재판청구권']
),
(
  'right-to-court',
  'Right of access to court',
  '재판청구권',
  '권리 침해를 주장하는 사람이 독립된 법원 또는 재판기관에 접근해 판단을 받을 수 있는 절차적 기본권이다.',
  null,
  array['재판청구권', 'Access to court']
),
(
  'ripeness',
  'Ripeness',
  '성숙성',
  '미국 연방법원에서 분쟁이 아직 충분히 현실화되지 않았으면 판단하지 않는 사법심사 제한 원칙이다.',
  'United States',
  array['Ripeness', 'Article III']
),
(
  'rule-of-law',
  'Rule of law / Rechtsstaat',
  '법치주의',
  '국가권력이 법에 근거하고, 예측 가능하며, 기본권과 권력분립의 한계 안에서 행사되어야 한다는 헌법 원리다.',
  null,
  array['법치주의', 'Rechtsstaat', 'Rule of law']
),
(
  'separation-of-powers',
  'Separation of powers',
  '권력분립',
  '입법, 행정, 사법 권한을 분산하고 상호 견제하게 하여 권력 집중과 자의적 국가작용을 막는 헌법 원리다.',
  null,
  array['권력분립', 'Separation of powers']
),
(
  'sincerite-du-scrutin',
  'Sincerite du scrutin',
  '선거의 진정성',
  '프랑스 선거심사에서 선거 과정의 위법이 유권자의 자유로운 의사와 결과의 신뢰성을 해쳤는지 판단하는 기준이다.',
  'France',
  array['Sincérité du scrutin', '선거무효', '프랑스 선거']
),
(
  'standing',
  'Standing',
  '당사자적격',
  '미국 연방법원에서 원고가 구체적 손해, 인과관계, 구제가능성을 보여야 본안 판단을 받을 수 있다는 사법심사 요건이다.',
  'United States',
  array['Standing', 'Article III', '당사자적격']
),
(
  'strict-scrutiny',
  'Strict scrutiny',
  '엄격심사',
  '중요한 기본권 제한이나 의심스러운 차별에 대해 중대한 정부 이익과 엄밀하게 맞춘 수단을 요구하는 미국 헌법심사 기준이다.',
  'United States',
  array['Strict scrutiny', 'Equal Protection', 'First Amendment']
),
(
  'subsidiarity',
  'Subsidiarity / Subsidiaritat',
  '보충성 원칙',
  '헌법재판을 청구하기 전에 가능한 일반 법적 구제수단을 먼저 사용해야 한다는 절차 원칙이다.',
  'Germany',
  array['보충성 원칙', 'Subsidiarität', '헌법소원']
)
on conflict (slug) do update set
  term = excluded.term,
  korean_term = excluded.korean_term,
  definition = excluded.definition,
  jurisdiction = excluded.jurisdiction,
  related_tags = excluded.related_tags,
  updated_at = now();
