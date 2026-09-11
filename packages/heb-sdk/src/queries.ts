/**
 * Full GraphQL query text for mobile operations, used as the APQ
 * (automatic persisted query) fallback when the server answers
 * PersistedQueryNotFound for a hash-only request.
 *
 * H-E-B's mobile GraphQL edge caches persisted queries per instance, so a
 * valid hash intermittently misses. The standard APQ recovery is to resend
 * the request with the full `query` text alongside its sha256, which the
 * server validates, executes and caches.
 *
 * These are reconstructed from the response shapes the SDK already consumes
 * and validated against the endpoint's schema validator (it runs before auth
 * and rejects unknown fields/arguments). They are not byte-identical to the
 * app's queries, so their sha256 differs from MOBILE_GRAPHQL_HASHES; the
 * fallback computes the hash from the text it sends.
 *
 * Schema notes (2026-09-09): `weeklyAd.info`, `productSearch.info`,
 * `productSearch.productPage` and `order.readyOrder` are unions whose
 * members must be selected with inline fragments; the error members expose
 * `message`. Weekly-ad products are the shared `Product` type (`id`, `SKUs`),
 * aliased to `productId` / `skus` so the response matches weekly-ad.ts.
 * ProductDetailsPage added 2026-09-10; argument names and variable types
 * confirmed by the validator (`id`/`storeId` are `ID!`, and the result is
 * the union `ProductDetailsPageResult`, whose product-bearing member is
 * `ProductDetailsPage`). On `Product`, `productCategory` is the department and
 * `parentCategory` the leaf type (the names are inverted); `breadcrumbs`
 * carries the full path (`H-E-B > Shop > Pantry > Sauces & marinades > Soy
 * sauces`). The app's own persisted query selects only `productCategory
 * { name }`, so this op is sent text-first (see api.ts TEXT_FIRST); a
 * hash-first request could never return the path. `ProductSearchPageV2` has no text: its result
 * member `SearchPage` exposes `layout` of type `Layout`, and `Layout` has
 * no `visualComponents` field, so the shape search.ts reads could not be
 * expressed within the probe budget (see HANDOFF.md, "APQ misses").
 */

/** Every MobileProduct field product-mapper.ts reads, on the shared Product type. */
const MOBILE_PRODUCT_FIELDS = `fragment MobileProductFields on Product {
  productId: id
  displayName
  productCategory { id name }
  parentCategory { id name }
  breadcrumbs { title categoryId }
  brand { name isOwnBrand }
  productLocation { availability location }
  carouselImageUrls
  inAssortment
  inventory { inventoryState }
  ingredientStatement
  productDescription
  preparationInstructions
  safetyWarning
  isAvailableForCheckout
  maximumOrderQuantity
  nutritionLabels {
    servingsPerContainer
    servingSize
    calories
    nutrients { title unit percentage subItems { title unit percentage } }
  }
  skus: SKUs {
    id
    productAvailability
    customerFriendlySize
    contextPrices {
      context
      isOnSale
      isPriceCut
      priceType
      listPrice { unit formattedAmount amount }
      salePrice { unit formattedAmount amount }
      unitListPrice { unit formattedAmount amount }
      unitSalePrice { unit formattedAmount amount }
    }
  }
}`;

export const MOBILE_QUERY_TEXT: Record<string, string> = {
  orderHistory: `query orderHistory($mode: OrderHistoryMode!, $offset: Int!, $omitOrderItems: Boolean!, $size: Int!, $status: OrderHistoryStatus!) {
  orderHistoryRequest(mode: $mode, offset: $offset, omitOrderItems: $omitOrderItems, size: $size, status: $status) {
    orderHistory {
      orders {
        orderId
        status
        orderStatusMessageShort
        fulfillmentType
        productCount
        orderChangesOverview { reviewChangesEligible unfulfilledCount }
        store { name latitude longitude }
        orderTimeslot { startTime endTime }
        totalPrice { formattedAmount }
      }
    }
  }
}`,

  orderDetails: `query orderDetails($orderId: String!, $includeReadyOrder: Boolean!) {
  orderDetailsRequest(orderId: $orderId) {
    order {
      orderId
      status
      orderStatusMessageShort
      fulfillmentType
      orderPlacedOnDateTime
      priceDetails {
        subtotal { formattedAmount }
        total { formattedAmount }
        tax { formattedAmount }
      }
      orderTimeslot { startDateTime endDateTime }
      store { id name address1 city state postalCode }
      orderItems {
        quantity
        product {
          id
          fullDisplayName
          thumbnailImageUrls { size url }
          SKUs { id }
        }
        totalUnitPrice { amount formattedAmount }
      }
      readyOrder @include(if: $includeReadyOrder) {
        __typename
        ... on SingleReadyOrderWrapper { order { orderId } }
        ... on SingleReadyOrderErrorResponse { message }
      }
    }
  }
}`,

  weeklyAdProductCategoryPage: `query weeklyAdProductCategoryPage($filters: WeeklyAdProductSearchFilter!, $isAuthenticated: Boolean!, $limit: Int!, $shoppingContext: ShoppingContext!, $storeId: Int!, $cursor: String) {
  weeklyAd(storeId: $storeId) {
    __typename @include(if: $isAuthenticated)
    productSearch(filters: $filters) {
      info {
        __typename
        ... on WeeklyAdProductSearchInfo {
          total
          filterCounts { categories { filter displayName count } }
        }
        ... on SavingsInvalidRequestError { message }
        ... on SavingsUnknownError { message }
      }
      productPage(shoppingContext: $shoppingContext, limit: $limit, cursor: $cursor) {
        __typename
        ... on SavingsProductPage {
          cursorList
          products {
            productId: id
            displayName
            brand { name }
            carouselImageUrls
            productLocation { location }
            skus: SKUs {
              id
              twelveDigitUPC
              contextPrices {
                context
                priceType
                isOnSale
                salePrice { formattedAmount }
                listPrice { formattedAmount }
              }
            }
          }
        }
        ... on SavingsInvalidRequestError { message }
        ... on SavingsUnknownError { message }
      }
    }
  }
}`,

  weeklyAdLandingPageInfo: `query weeklyAdLandingPageInfo($filters: WeeklyAdProductSearchFilter!, $isAuthenticated: Boolean!, $storeId: Int!) {
  weeklyAd(storeId: $storeId) {
    __typename @include(if: $isAuthenticated)
    info {
      __typename
      ... on WeeklyAdInformation { daysRemaining startDate endDate }
      ... on SavingsInvalidRequestError { message }
      ... on SavingsUnknownError { message }
    }
    productSearch(filters: $filters) {
      info {
        __typename
        ... on WeeklyAdProductSearchInfo {
          total
          filterCounts { categories { filter displayName count } }
        }
        ... on SavingsInvalidRequestError { message }
        ... on SavingsUnknownError { message }
      }
    }
  }
}`,

  ProductDetailsPage: `query ProductDetailsPage($id: ID!, $isAuthenticated: Boolean!, $shoppingContext: ShoppingContext!, $storeId: ID!) {
  productDetailsPage(id: $id, storeId: $storeId, shoppingContext: $shoppingContext) {
    __typename @include(if: $isAuthenticated)
    ... on ProductDetailsPage { product { ...MobileProductFields } }
  }
}
${MOBILE_PRODUCT_FIELDS}`,
};
