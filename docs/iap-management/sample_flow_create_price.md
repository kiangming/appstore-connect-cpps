flow trên appstore connect để set price point:
step 1: get pricePoint
https://appstoreconnect.apple.com/iris/v2/inAppPurchases/6770029110/pricePoints?filter[territory]=USA&limit=1000&include=territory

format data như sau:
"data" :  {
    "type" : "inAppPurchasePricePoints",
    "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDEifQ",
    "attributes" : {
      "customerPrice" : "0.29",
      "proceeds" : "0.21",
      "currency" : "USD",
      "additional" : true
    },
    "relationships" : {
      "territory" : {
        "data" : {
          "type" : "territories",
          "id" : "USA"
        }
      },
      "equalizations" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDEifQ/relationships/equalizations",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDEifQ/equalizations"
        }
      }
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDEifQ"
    }
  }, {
    "type" : "inAppPurchasePricePoints",
    "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDIifQ",
    "attributes" : {
      "customerPrice" : "0.39",
      "proceeds" : "0.28",
      "currency" : "USD",
      "additional" : true
    },
    "relationships" : {
      "territory" : {
        "data" : {
          "type" : "territories",
          "id" : "USA"
        }
      },
      "equalizations" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDIifQ/relationships/equalizations",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDIifQ/equalizations"
        }
      }
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMDIifQ"
    }
  }

step 2: appstore sẽ load list price của all  country https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMTAifQ/equalizations?include=territory&limit=200

format data có dạng:
"data" :  {
    "type" : "inAppPurchasePricePoints",
    "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBRkciLCJwIjoiMTAwMTAifQ",
    "attributes" : {
      "customerPrice" : "0.99",
      "proceeds" : "0.7",
      "currency" : "USD",
      "additional" : false
    },
    "relationships" : {
      "territory" : {
        "data" : {
          "type" : "territories",
          "id" : "AFG"
        }
      },
      "equalizations" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBRkciLCJwIjoiMTAwMTAifQ/relationships/equalizations",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBRkciLCJwIjoiMTAwMTAifQ/equalizations"
        }
      }
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBRkciLCJwIjoiMTAwMTAifQ"
    }
  }, {
    "type" : "inAppPurchasePricePoints",
    "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBR08iLCJwIjoiMTAwMTAifQ",
    "attributes" : {
      "customerPrice" : "0.99",
      "proceeds" : "0.7",
      "currency" : "USD",
      "additional" : false
    },
    "relationships" : {
      "territory" : {
        "data" : {
          "type" : "territories",
          "id" : "AGO"
        }
      },
      "equalizations" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBR08iLCJwIjoiMTAwMTAifQ/relationships/equalizations",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBR08iLCJwIjoiMTAwMTAifQ/equalizations"
        }
      }
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePricePoints/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJBR08iLCJwIjoiMTAwMTAifQ"
    }
  }
ở đây có thể thay đổi giá quy đổi của từng thị trường

step 3: review 

step 4: confirm để set
POST https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules

{
  "data" : {
    "type" : "inAppPurchasePriceSchedules",
    "id" : "6770029110",
    "attributes" : {
      "baseTerritoryConfigurationState" : "NOT_SET"
    },
    "relationships" : {
      "baseTerritory" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/relationships/baseTerritory",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/baseTerritory"
        }
      },
      "manualPrices" : {
        "meta" : {
          "paging" : {
            "total" : 1,
            "limit" : 10
          }
        },
        "data" : [ {
          "type" : "inAppPurchasePrices",
          "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMTAiLCJzZCI6MC4wLCJlZCI6MC4wfQ"
        } ],
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/relationships/manualPrices",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/manualPrices"
        }
      },
      "automaticPrices" : {
        "links" : {
          "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/relationships/automaticPrices",
          "related" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110/automaticPrices"
        }
      }
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules/6770029110"
    }
  },
  "included" : [ {
    "type" : "inAppPurchasePrices",
    "id" : "eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMTAiLCJzZCI6MC4wLCJlZCI6MC4wfQ",
    "attributes" : {
      "startDate" : null,
      "endDate" : null,
      "manual" : true
    },
    "links" : {
      "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePrices/eyJzIjoiNjc3MDAyOTExMCIsInQiOiJVU0EiLCJwIjoiMTAwMTAiLCJzZCI6MC4wLCJlZCI6MC4wfQ"
    }
  } ],
  "links" : {
    "self" : "https://appstoreconnect.apple.com/iris/v1/inAppPurchasePriceSchedules"
  }
}